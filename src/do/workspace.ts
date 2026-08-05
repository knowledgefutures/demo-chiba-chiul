/**
 * Data plane — one SQLite Durable Object per workspace.
 *
 * Hydrates from Underlay collections and answers the surface's queries. A Durable
 * Object rather than D1 because D1 bindings cannot be assigned dynamically, because
 * hydration needs somewhere to run that outlives a request (an alarm loop), and
 * because `sql.exec()` is synchronous and local so the dashboard aggregates are cheap.
 *
 * No sharding. 9,429 records against a 10 GB per-object ceiling — Ask's sharding exists
 * for 3M records and none of it is needed here.
 *
 * **It reads from the collections, not from the corpus.** That is deliberate: it makes
 * the surface an honest working copy of what was published, exercises the read path the
 * same way any other consumer would, and means the deployed Worker does not need 45 MB
 * of transcripts inside it.
 */
import { DurableObject } from 'cloudflare:workers'

import { classifyEntry, KIND_CODE } from '../lib/chi/kinds.ts'
import {
  CHARS_PER_TOKEN,
  computeMetrics,
  leafEntryIds,
  modelVisibleChars,
  sessionCwd,
  sessionTitle,
  UNATTRIBUTED,
} from '../lib/chi/project.ts'
import type { ChiEntry } from '../lib/chi/types.ts'
import { UnderlayClient } from '../lib/underlay/client.ts'

type HydrateConfig = {
  underlayUrl: string
  apiKey: string | null
  orgSlug: string
  /** Collections to read, in order. Later ones only add records the earlier lacked. */
  collections: { slug: string; version: string }[]
}

export type SessionRow = {
  sessionId: string
  title: string | null
  source: string
  repo: string | null
  cwd: string | null
  startedAt: string | null
  lastAt: string | null
  entryCount: number
  messageCount: number
  approxTokens: number
  costUsd: number
  models: string
  collectionSlug: string
}

export type EntryRow = {
  recordId: string
  sessionId: string
  seq: number
  z: number
  entryType: string
  role: string | null
  toolName: string | null
  model: string | null
  timestamp: string | null
  entryJson: string
}

/**
 * Bump when the local table shape changes. Everything here is a projection of the
 * collections, so a mismatch drops and rebuilds rather than migrating — there is no
 * authoritative data in this object to preserve, and a real migration would be
 * ceremony over a cache.
 */
const SCHEMA_VERSION = 3

/**
 * CSI sequences plus a bare-ESC fallback. Applied to indexed text only — the stored
 * entry keeps every byte, because the round-trip guarantee depends on it.
 */
// oxlint-disable-next-line no-control-regex -- matching ANSI escapes is the point
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '')
}

export class Workspace extends DurableObject<Env> {
  private sql: SqlStorage

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.migrate()
  }

  private migrate(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`)

    /**
     * `CREATE TABLE IF NOT EXISTS` is a trap when columns are added: the table already
     * exists, so the new column silently does not, and the next insert fails with a
     * column-count error that names nothing useful. Drop on version mismatch instead —
     * safe here precisely because this object holds no authoritative data, only a
     * projection that `hydrate()` can rebuild from the collections in ~9 seconds.
     */
    const stored = Number(this.getMeta('schemaVersion') ?? 0)
    if (stored !== 0 && stored !== SCHEMA_VERSION) {
      /**
       * `pending` is deliberately absent from this list. Everything else here is a
       * projection of the collections and can be rebuilt by `hydrate()`; buffered writes
       * that have not been committed upstream yet are the one thing in this object that is
       * authoritative, and dropping them would lose data a client already handed us.
       */
      for (const table of ['entries_fts', 'entries', 'sessions', 'metrics', 'session_links']) {
        this.sql.exec(`DROP TABLE IF EXISTS ${table}`)
      }
      this.setMeta('status', 'empty')
      this.setMeta('recordsRead', '0')
    }

    this.sql.exec(`

      CREATE TABLE IF NOT EXISTS sessions (
        session_id      TEXT PRIMARY KEY,
        title           TEXT,
        source          TEXT NOT NULL,
        repo            TEXT,
        cwd             TEXT,
        started_at      TEXT,
        last_at         TEXT,
        entry_count     INTEGER NOT NULL DEFAULT 0,
        message_count   INTEGER NOT NULL DEFAULT 0,
        approx_tokens   INTEGER NOT NULL DEFAULT 0,
        cost_usd        REAL NOT NULL DEFAULT 0,
        models          TEXT NOT NULL DEFAULT '[]',
        leaf_entry_ids  TEXT NOT NULL DEFAULT '[]',
        -- Whether the source file ended with a newline. Part of the published Session
        -- record, so it has to survive here or re-publishing would rewrite all 65.
        trailing_newline INTEGER NOT NULL DEFAULT 1,
        collection_slug TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_source_idx ON sessions(source);
      CREATE INDEX IF NOT EXISTS sessions_started_idx ON sessions(started_at);

      -- One row per Entry record. \`entry_json\` is the v3 entry exactly as stored
      -- upstream, so anything the surface has not thought to project is still here.
      CREATE TABLE IF NOT EXISTS entries (
        record_id   TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        z           INTEGER NOT NULL DEFAULT 0,
        entry_type  TEXT NOT NULL,
        role        TEXT,
        tool_name   TEXT,
        model       TEXT,
        timestamp   TEXT,
        text        TEXT,
        -- Visual kind (see lib/chi/kinds.ts). Stored rather than derived per query so
        -- the corpus map is one indexed scan instead of 9,299 JSON parses.
        kind        TEXT NOT NULL DEFAULT 'event',
        -- Carried through from the record so re-publishing reproduces it exactly. Without
        -- it the two escaped records would re-upload on every commit instead of deduping.
        pg_escaped  INTEGER NOT NULL DEFAULT 0,
        entry_json  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS entries_session_idx ON entries(session_id, z, seq);
      CREATE INDEX IF NOT EXISTS entries_tool_idx ON entries(tool_name);

      CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(
        text, content='entries', content_rowid='rowid', tokenize='porter'
      );

      CREATE TABLE IF NOT EXISTS metrics (
        scope      TEXT NOT NULL,
        scope_id   TEXT NOT NULL,
        data_json  TEXT NOT NULL,
        PRIMARY KEY (scope, scope_id)
      );

      -- The write buffer: entries accepted from a client but not yet committed upstream.
      -- This is the "fast layer" — a session writes here at app latency and Underlay gets
      -- one version per flush interval instead of one per turn.
      CREATE TABLE IF NOT EXISTS pending (
        record_id   TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        received_at TEXT NOT NULL,
        token_id    TEXT,
        entry_json  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pending_session_idx ON pending(session_id, seq);

      -- Parent/child session links, from the subagent.link custom records. Kept as its
      -- own table because the edge is a fact about two sessions, not a field on either.
      CREATE TABLE IF NOT EXISTS session_links (
        origin_session_id TEXT NOT NULL,
        child_session_id  TEXT NOT NULL,
        specialist_id     TEXT,
        PRIMARY KEY (origin_session_id, child_session_id)
      );
    `)
    this.setMeta('schemaVersion', String(SCHEMA_VERSION))
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', key, value)
  }

  private getMeta(key: string): string | null {
    const row = this.sql.exec('SELECT value FROM meta WHERE key = ?', key).toArray()[0]
    return row ? (row['value'] as string) : null
  }

  // --- Hydration ---

  /**
   * Read every record from the configured collections and build the local tables.
   *
   * Runs inline rather than in an alarm: 9,429 records is ~15 s of paged reads, which
   * fits a request. An alarm loop is the right shape at Ask's scale and unnecessary
   * complexity at this one. The status fields exist so the UI can poll either way.
   */
  async hydrate(config: HydrateConfig): Promise<{ records: number; sessions: number }> {
    this.setMeta('status', 'hydrating')
    this.setMeta('hydrateStartedAt', new Date().toISOString())

    try {
      const client = new UnderlayClient({
        baseUrl: config.underlayUrl,
        apiKey: config.apiKey ?? undefined,
      })

      /**
       * `entries_fts` is an FTS5 **external-content** table: its rows are a view over
       * `entries`, not a copy. `DELETE FROM entries_fts` therefore does not empty it —
       * it writes delete-markers keyed to rows that are about to disappear, and the
       * next rebuild lands on an index that disagrees with its content table. That
       * surfaces as `SQLITE_CORRUPT_VTAB` on the following hydrate, which reads as a
       * disk problem and is not one.
       *
       * Dropping and recreating it is unconditionally safe and costs nothing, since it
       * holds no data of its own.
       */
      this.sql.exec('DROP TABLE IF EXISTS entries_fts')
      this.sql.exec('DELETE FROM entries')
      this.sql.exec('DELETE FROM sessions')
      this.sql.exec('DELETE FROM metrics')
      this.sql.exec('DELETE FROM session_links')

      let records = 0
      for (const { slug, version } of config.collections) {
        for await (const page of client.pageRecords(config.orgSlug, slug, version)) {
          this.ingestPage(page, slug)
          records += page.length
          this.setMeta('recordsRead', String(records))
        }
      }

      // Recreated and rebuilt once at the end, rather than written incrementally during
      // ingest: `rebuild` is the supported way to populate an external-content index
      // from its content table, and one pass is cheaper than 9,299 index writes.
      this.sql.exec(`
        CREATE VIRTUAL TABLE entries_fts USING fts5(
          text, content='entries', content_rowid='rowid', tokenize='porter'
        );
      `)
      this.sql.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`)

      const sessions = Number(
        this.sql.exec('SELECT COUNT(*) AS n FROM sessions').toArray()[0]?.['n'] ?? 0,
      )
      this.setMeta('status', 'ready')
      this.setMeta('recordsRead', String(records))
      this.setMeta('hydratedAt', new Date().toISOString())
      return { records, sessions }
    } catch (err) {
      this.setMeta('status', 'error')
      this.setMeta('statusDetail', err instanceof Error ? err.message : String(err))
      throw err
    }
  }

  /**
   * One page of records into the tables.
   *
   * `INSERT OR IGNORE` on entries and sessions is what makes multiple collection
   * layouts over the same records safe to read in sequence: the per-repo collection
   * holds all 65 sessions and the per-person ones hold the same records again, so the
   * second pass legitimately re-sees everything and must not duplicate it.
   */
  private ingestPage(
    page: { id: string; type: string; data: Record<string, unknown> }[],
    collectionSlug: string,
  ): void {
    for (const record of page) {
      if (record.type === 'Session') {
        const d = record.data
        this.sql.exec(
          `INSERT OR IGNORE INTO sessions
             (session_id, title, source, repo, cwd, started_at, last_at, entry_count,
              message_count, approx_tokens, cost_usd, models, leaf_entry_ids,
              trailing_newline, collection_slug)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          String(d['sessionId'] ?? record.id),
          (d['title'] as string | null) ?? null,
          String(d['source'] ?? 'Unattributed'),
          (d['repo'] as string | null) ?? null,
          (d['cwd'] as string | null) ?? null,
          (d['startedAt'] as string | null) ?? null,
          (d['lastAt'] as string | null) ?? null,
          Number(d['entryCount'] ?? 0),
          Number(d['messageCount'] ?? 0),
          Number(d['approxTokens'] ?? 0),
          Number(d['costUsd'] ?? 0),
          JSON.stringify(d['models'] ?? []),
          JSON.stringify(d['leafEntryIds'] ?? []),
          d['trailingNewline'] === false ? 0 : 1,
          collectionSlug,
        )
      } else if (record.type === 'Metrics') {
        this.sql.exec(
          'INSERT OR REPLACE INTO metrics (scope, scope_id, data_json) VALUES (?,?,?)',
          String(record.data['scope'] ?? 'session'),
          String(record.data['scopeId'] ?? record.id),
          JSON.stringify(record.data),
        )
      } else if (record.type === 'Entry') {
        this.ingestEntry(record)
      }
    }
  }

  private ingestEntry(record: { id: string; data: Record<string, unknown> }): void {
    const entry = record.data['entry'] as Record<string, unknown> | undefined
    if (!entry) return

    const message = entry['message'] as Record<string, unknown> | undefined
    const content = message?.['content']
    let text = ''
    let toolName = (message?.['toolName'] as string | undefined) ?? null

    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      for (const part of content as Record<string, unknown>[]) {
        if (typeof part['text'] === 'string') text += `${part['text']}\n`
        if (part['type'] === 'toolCall') {
          // A toolCall part names its tool in `name`; a toolResult *message* uses
          // `toolName`. Reading only `toolName` here silently left every assistant
          // invocation unlabelled, which made the tool-mix chart count results
          // instead of calls — same order of magnitude, wrong thing measured.
          toolName ??=
            (part['toolName'] as string | undefined) ?? (part['name'] as string | undefined) ?? null
        }
      }
    }

    this.sql.exec(
      `INSERT OR IGNORE INTO entries
         (record_id, session_id, seq, z, entry_type, role, tool_name, model, timestamp, text,
          kind, pg_escaped, entry_json)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      record.id,
      String(record.data['sessionId'] ?? ''),
      Number(record.data['seq'] ?? 0),
      Number(record.data['z'] ?? 0),
      String(entry['type'] ?? 'unknown'),
      (message?.['role'] as string | undefined) ?? null,
      toolName,
      (message?.['model'] as string | undefined) ?? null,
      (entry['timestamp'] as string | undefined) ?? null,
      // For the search index and its snippets only; `entry_json` keeps the entry
      // untouched. ANSI escapes are stripped because the corpus carries 3,928 of them
      // from terminal output, and a snippet reading `[32m✓ [0m secret-scan-passed` is
      // noise in a result list. They are never search terms, so nothing is lost.
      stripAnsi(text).slice(0, 20_000),
      classifyEntry(entry),
      record.data['pgEscaped'] === true ? 1 : 0,
      JSON.stringify(entry),
    )

    // Subagent parent→child edges live in `custom` records, not in the tree.
    if (entry['type'] === 'custom' && entry['customType'] === 'subagent.link') {
      const d = entry['data'] as Record<string, unknown> | undefined
      if (d?.['originSessionId'] && d['childSessionId']) {
        this.sql.exec(
          `INSERT OR IGNORE INTO session_links (origin_session_id, child_session_id, specialist_id)
           VALUES (?,?,?)`,
          String(d['originSessionId']),
          String(d['childSessionId']),
          (d['specialistId'] as string | undefined) ?? null,
        )
      }
    }
  }

  // --- The write buffer ---

  /**
   * Accept entries from a client. Returns what was new.
   *
   * Idempotent by `(sessionId, entryId|seq)`: a client that retries a batch, or replays a
   * session from the start after a reconnect, does not duplicate anything. That matters
   * because Chi's own duplicates come from replication rather than concurrency, so the
   * ingest surface should be safe to point two machines at.
   */
  accept(
    entries: { sessionId: string; seq: number; entry: Record<string, unknown> }[],
    tokenId: string | null,
    /** Repo the session belongs to, which decides the collection it publishes into. */
    repo: string | null = null,
  ): { accepted: number; duplicates: number; pending: number } {
    const now = new Date().toISOString()
    let accepted = 0

    for (const item of entries) {
      const entryId =
        typeof item.entry['id'] === 'string' ? (item.entry['id'] as string) : `#${item.seq}`
      const recordId = `${item.sessionId}:${entryId}`

      // Already committed upstream? Then this is a replay, not a new write.
      const known = this.sql
        .exec('SELECT 1 AS hit FROM entries WHERE record_id = ? LIMIT 1', recordId)
        .toArray()
      if (known.length > 0) continue

      const cursor = this.sql.exec(
        `INSERT OR IGNORE INTO pending (record_id, session_id, seq, received_at, token_id, entry_json)
         VALUES (?,?,?,?,?,?)`,
        recordId,
        item.sessionId,
        item.seq,
        now,
        tokenId,
        JSON.stringify(item.entry),
      )
      accepted += cursor.rowsWritten > 0 ? 1 : 0
    }

    // Remember the repo now, while the writer is telling us. Recovering it later would mean
    // guessing, and a session with no repo cannot be published at all.
    if (repo) {
      for (const sessionId of new Set(entries.map((e) => e.sessionId))) {
        this.sql.exec(
          `INSERT INTO sessions
             (session_id, title, source, repo, cwd, entry_count, message_count, approx_tokens,
              cost_usd, models, leaf_entry_ids, trailing_newline, collection_slug)
           VALUES (?,?,?,?,?,0,0,0,0,'[]','[]',1,'live')
           ON CONFLICT(session_id) DO UPDATE SET repo = excluded.repo`,
          sessionId,
          null,
          UNATTRIBUTED,
          repo,
          null,
        )
      }
    }

    return {
      accepted,
      duplicates: entries.length - accepted,
      pending: this.pendingCount(),
    }
  }

  pendingCount(): number {
    return Number(this.sql.exec('SELECT COUNT(*) AS n FROM pending').toArray()[0]?.['n'] ?? 0)
  }

  /**
   * Drop the buffer without publishing. Returns how many entries were dropped.
   *
   * Also removes session rows left with no entries. `accept()` writes a placeholder session row
   * as soon as a writer names a repo — so discarding only the entries stranded those rows as
   * phantom sessions with zero records, which then showed up in every count and every list.
   */
  discardPending(): number {
    const n = this.pendingCount()
    this.sql.exec('DELETE FROM pending')
    this.sql.exec(`
      DELETE FROM metrics
      WHERE scope = 'session'
        AND scope_id IN (
          SELECT s.session_id FROM sessions s
          WHERE NOT EXISTS (SELECT 1 FROM entries e WHERE e.session_id = s.session_id)
        )
    `)
    this.sql.exec(`
      DELETE FROM sessions
      WHERE NOT EXISTS (SELECT 1 FROM entries e WHERE e.session_id = sessions.session_id)
    `)
    return n
  }

  pendingSummary(): {
    pending: number
    sessions: { sessionId: string; entries: number; oldest: string | null }[]
  } {
    return {
      pending: this.pendingCount(),
      sessions: this.sql
        .exec(
          `SELECT session_id AS sessionId, COUNT(*) AS entries, MIN(received_at) AS oldest
           FROM pending GROUP BY session_id ORDER BY oldest`,
        )
        .toArray()
        .map((r) => ({
          sessionId: String(r['sessionId']),
          entries: Number(r['entries']),
          oldest: (r['oldest'] as string | null) ?? null,
        })),
    }
  }

  /**
   * Move buffered entries into the main tables so the next publish picks them up.
   *
   * Sessions and Metrics are recomputed from the entries this object now holds, so a
   * buffered session becomes a first-class session with a spine and a metrics record —
   * exactly as if it had been ingested from a file.
   */
  private promotePending(): number {
    const rows = this.sql
      .exec(
        `SELECT record_id AS recordId, session_id AS sessionId, seq, entry_json AS entryJson
         FROM pending ORDER BY session_id, seq`,
      )
      .toArray()
    if (rows.length === 0) return 0

    for (const row of rows) {
      this.ingestEntry({
        id: String(row['recordId']),
        data: {
          sessionId: String(row['sessionId']),
          seq: Number(row['seq']),
          z: 0,
          entry: JSON.parse(String(row['entryJson'])) as Record<string, unknown>,
        },
      })
    }

    // Any session that gained entries needs its spine and metrics rebuilt.
    for (const sessionId of new Set(rows.map((r) => String(r['sessionId'])))) {
      this.rebuildSession(sessionId)
    }

    this.sql.exec('DELETE FROM pending')
    this.sql.exec('DROP TABLE IF EXISTS entries_fts')
    this.sql.exec(`
      CREATE VIRTUAL TABLE entries_fts USING fts5(
        text, content='entries', content_rowid='rowid', tokenize='porter'
      );
    `)
    this.sql.exec(`INSERT INTO entries_fts(entries_fts) VALUES('rebuild')`)
    return rows.length
  }

  /**
   * Derive a Session row and its Metrics from the entries currently held.
   *
   * Reuses the same projection the offline tool uses, so a session that arrived over the
   * wire is indistinguishable from one that arrived from a file — including its
   * `approxTokens` estimate and its cost roll-up.
   */
  private rebuildSession(sessionId: string): void {
    const entries = this.sql
      .exec(
        'SELECT entry_json AS entryJson FROM entries WHERE session_id = ? AND z = 0 ORDER BY seq',
        sessionId,
      )
      .toArray()
      .map((r) => JSON.parse(String(r['entryJson'])) as ChiEntry)
    if (entries.length === 0) return

    const metrics = computeMetrics(entries)
    const timestamps = entries
      .map((e) => e['timestamp'])
      .filter((t): t is string => typeof t === 'string')
      .sort()
    const cwd = sessionCwd(entries)
    const existing = this.sql
      .exec('SELECT source, repo, collection_slug FROM sessions WHERE session_id = ?', sessionId)
      .toArray()[0]

    this.sql.exec(
      `INSERT OR REPLACE INTO sessions
         (session_id, title, source, repo, cwd, started_at, last_at, entry_count, message_count,
          approx_tokens, cost_usd, models, leaf_entry_ids, trailing_newline, collection_slug)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      sessionId,
      sessionTitle(entries),
      // A live session's source is unknown until someone maps it; label it rather than
      // guessing, exactly as the offline path does.
      (existing?.['source'] as string | undefined) ?? UNATTRIBUTED,
      (existing?.['repo'] as string | undefined) ?? null,
      cwd,
      timestamps[0] ?? null,
      timestamps[timestamps.length - 1] ?? null,
      entries.length,
      metrics.entryTypes['message'] ?? 0,
      Math.round(modelVisibleChars(entries) / CHARS_PER_TOKEN),
      metrics.costUsd,
      JSON.stringify(metrics.models),
      JSON.stringify(leafEntryIds(entries)),
      1,
      (existing?.['collection_slug'] as string | undefined) ?? 'live',
    )

    this.sql.exec(
      'INSERT OR REPLACE INTO metrics (scope, scope_id, data_json) VALUES (?,?,?)',
      'session',
      sessionId,
      JSON.stringify({ scope: 'session', scopeId: sessionId, ...metrics }),
    )
  }

  // --- Publishing ---

  /**
   * Re-publish what this workspace holds, under a chosen collection layout.
   *
   * This is the write half, and it runs inside the Durable Object rather than the Worker
   * so 21 MB of records never crosses an RPC boundary. It reconstructs the *same*
   * records that were originally pushed — same fields, same values — which is what makes
   * the interesting outcome possible: hash negotiation finds every record already
   * stored, `needed_records` comes back empty, and a second layout costs one manifest
   * and zero record bytes.
   *
   * That only holds if reconstruction is exact. Two fields exist purely for it:
   * `pg_escaped` and `trailing_newline`. Drop either and this quietly re-uploads.
   */
  async publish(config: {
    underlayUrl: string
    apiKey: string | null
    orgSlug: string
    /** `person` groups by source label; `repo` groups by repo. */
    layout: 'person' | 'repo'
    prefix: string
    schemas: Record<string, Record<string, unknown>>
  }): Promise<
    {
      slug: string
      semver: string
      records: number
      uploaded: number
      /** Underlay found the version byte-identical to what is already stored. */
      unchanged?: boolean
      error?: string
    }[]
  > {
    // Buffered writes join the main tables before anything is hashed, so a flush and a
    // re-publish are the same operation — content addressing then means only the new
    // records travel.
    const promoted = this.promotePending()

    const client = new UnderlayClient({
      baseUrl: config.underlayUrl,
      apiKey: config.apiKey ?? undefined,
    })

    const sessions = this.sql
      .exec(
        `SELECT session_id AS sessionId, title, source, repo, cwd, started_at AS startedAt,
                last_at AS lastAt, entry_count AS entryCount, message_count AS messageCount,
                approx_tokens AS approxTokens, cost_usd AS costUsd, models,
                leaf_entry_ids AS leafEntryIds, trailing_newline AS trailingNewline
         FROM sessions`,
      )
      .toArray()

    /**
     * Group into collection slugs, and refuse to invent one.
     *
     * A session with no `repo` used to fall back to the literal string `unknown`, which
     * quietly created a junk `chi-unknown` collection upstream the first time a live
     * session arrived without repo metadata. Publishing should never conjure a collection
     * out of a missing field: such sessions are skipped and named in the result, so the
     * fix is to give them a repo rather than to discover the collection later.
     */
    const groups = new Map<string, string[]>()
    const ungrouped: string[] = []
    for (const row of sessions) {
      const key =
        config.layout === 'repo'
          ? ((row['repo'] as string | null) ?? null)
          : ((row['source'] as string | null) ?? 'Unattributed')
      if (!key) {
        ungrouped.push(String(row['sessionId']))
        continue
      }
      const slug = `${config.prefix}-${key.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
      groups.set(slug, [...(groups.get(slug) ?? []), String(row['sessionId'])])
    }

    const results: {
      slug: string
      semver: string
      records: number
      uploaded: number
      unchanged?: boolean
      error?: string
    }[] = []

    for (const [slug, sessionIds] of [...groups].sort()) {
      const records: { id: string; type: string; data: Record<string, unknown> }[] = []

      for (const sessionId of sessionIds) {
        const session = sessions.find((s) => s['sessionId'] === sessionId)!

        for (const entry of this.sql
          .exec(
            `SELECT record_id AS recordId, seq, z, pg_escaped AS pgEscaped, entry_json AS entryJson
             FROM entries WHERE session_id = ? ORDER BY seq`,
            sessionId,
          )
          .toArray()) {
          records.push({
            id: String(entry['recordId']),
            type: 'Entry',
            data: {
              sessionId,
              seq: Number(entry['seq']),
              z: Number(entry['z']),
              reductionId: null,
              entry: JSON.parse(String(entry['entryJson'])) as Record<string, unknown>,
              ...(entry['pgEscaped'] === 1 ? { pgEscaped: true } : {}),
            },
          })
        }

        records.push({
          id: sessionId,
          type: 'Session',
          data: {
            sessionId,
            title: session['title'] ?? null,
            startedAt: session['startedAt'] ?? null,
            lastAt: session['lastAt'] ?? null,
            source: session['source'],
            repo: session['repo'] ?? null,
            cwd: session['cwd'] ?? null,
            entryCount: Number(session['entryCount']),
            messageCount: Number(session['messageCount']),
            approxTokens: Number(session['approxTokens']),
            costUsd: Number(session['costUsd']),
            models: JSON.parse(String(session['models'])) as string[],
            leafEntryIds: JSON.parse(String(session['leafEntryIds'])) as string[],
            trailingNewline: session['trailingNewline'] === 1,
          },
        })

        const metrics = this.sql
          .exec(`SELECT data_json FROM metrics WHERE scope = 'session' AND scope_id = ?`, sessionId)
          .toArray()[0]
        if (metrics) {
          records.push({
            id: `${sessionId}:metrics`,
            type: 'Metrics',
            data: JSON.parse(String(metrics['data_json'])) as Record<string, unknown>,
          })
        }
      }

      let latestKnown: string | null = null
      try {
        const collection = await client.createCollection(config.orgSlug, slug, {
          name: `Chi sessions — ${slug.replace(`${config.prefix}-`, '')}`,
          public: false,
        })
        const latest = await client.latestVersion(config.orgSlug, slug)
        latestKnown = latest?.semver ?? null
        const pushed = await client.push(config.orgSlug, slug, records, {
          schemas: config.schemas,
          message: `chiul re-publish — layout=${config.layout}`,
          baseVersion: latest?.semver ?? null,
          appId: 'chiul',
        })
        results.push({
          slug,
          semver: pushed.semver,
          records: pushed.recordCount,
          uploaded: pushed.uploaded,
        })
        void collection
      } catch (err) {
        /**
         * A 409 "No changes detected" is the *best* outcome, not a failure.
         *
         * It means Underlay computed the version hash over what we sent and found it
         * identical to the version already stored — so this object's reconstruction of
         * the records is exact, field for field, including the two fields that exist only
         * to make it so (`pg_escaped`, `trailing_newline`). Stronger evidence than
         * `uploaded: 0`, which only proves the record bodies were already present.
         */
        const message = err instanceof Error ? err.message : String(err)
        if (message.includes('No changes detected')) {
          const existing = /"existingVersion":"([^"]+)"/.exec(message)?.[1] ?? (latestKnown ?? '—')
          results.push({
            slug,
            semver: existing,
            records: records.length,
            uploaded: 0,
            unchanged: true,
          })
          continue
        }
        results.push({
          slug,
          semver: '—',
          records: records.length,
          uploaded: 0,
          error: message,
        })
      }
    }

    if (promoted > 0) this.setMeta('lastPromoted', String(promoted))
    if (ungrouped.length > 0) {
      results.push({
        slug: '(skipped)',
        semver: '—',
        records: 0,
        uploaded: 0,
        error: `${ungrouped.length} session(s) have no repo and were not published: ${ungrouped
          .slice(0, 3)
          .join(', ')}`,
      })
    }
    return results
  }

  // --- Reads ---

  status(): {
    status: string
    statusDetail: string | null
    recordsRead: number
    sessions: number
    entries: number
    hydratedAt: string | null
  } {
    return {
      status: this.getMeta('status') ?? 'empty',
      statusDetail: this.getMeta('statusDetail'),
      recordsRead: Number(this.getMeta('recordsRead') ?? 0),
      sessions: Number(this.sql.exec('SELECT COUNT(*) AS n FROM sessions').toArray()[0]?.['n'] ?? 0),
      entries: Number(this.sql.exec('SELECT COUNT(*) AS n FROM entries').toArray()[0]?.['n'] ?? 0),
      hydratedAt: this.getMeta('hydratedAt'),
    }
  }

  listSessions(): SessionRow[] {
    return this.sql
      .exec(
        `SELECT session_id AS sessionId, title, source, repo, cwd, started_at AS startedAt,
                last_at AS lastAt, entry_count AS entryCount, message_count AS messageCount,
                approx_tokens AS approxTokens, cost_usd AS costUsd, models,
                collection_slug AS collectionSlug
         FROM sessions ORDER BY started_at`,
      )
      .toArray() as unknown as SessionRow[]
  }

  getSession(sessionId: string): SessionRow | null {
    const rows = this.sql
      .exec(
        `SELECT session_id AS sessionId, title, source, repo, cwd, started_at AS startedAt,
                last_at AS lastAt, entry_count AS entryCount, message_count AS messageCount,
                approx_tokens AS approxTokens, cost_usd AS costUsd, models,
                collection_slug AS collectionSlug
         FROM sessions WHERE session_id = ?`,
        sessionId,
      )
      .toArray() as unknown as SessionRow[]
    return rows[0] ?? null
  }

  listEntries(sessionId: string, z: number, limit: number, offset: number): EntryRow[] {
    return this.sql
      .exec(
        `SELECT record_id AS recordId, session_id AS sessionId, seq, z,
                entry_type AS entryType, role, tool_name AS toolName, model, timestamp, entry_json AS entryJson
         FROM entries WHERE session_id = ? AND z = ? ORDER BY seq LIMIT ? OFFSET ?`,
        sessionId,
        z,
        limit,
        offset,
      )
      .toArray() as unknown as EntryRow[]
  }

  /**
   * The shape of every session, as one string of kind codes per session.
   *
   * This is what makes the corpus view possible: 9,299 entries arrive as ~9 KB of
   * single characters rather than 9,299 objects, so the whole corpus can be drawn at
   * once and zoomed without paging. `marks[i]` is the kind of entry `i`.
   */
  corpusMarks(): { sessionId: string; source: string; marks: string }[] {
    const rows = this.sql
      .exec(
        `SELECT session_id AS sessionId, kind, seq
         FROM entries WHERE z = 0 ORDER BY session_id, seq`,
      )
      .toArray()

    const bySession = new Map<string, string[]>()
    for (const row of rows) {
      const id = String(row['sessionId'])
      const acc = bySession.get(id) ?? []
      acc.push(KIND_CODE[row['kind'] as keyof typeof KIND_CODE] ?? 'e')
      bySession.set(id, acc)
    }

    const sources = new Map(
      this.sql
        .exec('SELECT session_id, source FROM sessions')
        .toArray()
        .map((r) => [String(r['session_id']), String(r['source'])]),
    )

    return [...bySession].map(([sessionId, marks]) => ({
      sessionId,
      source: sources.get(sessionId) ?? 'Unattributed',
      marks: marks.join(''),
    }))
  }

  /** Which z levels actually exist for a session. Drives the z selector honestly. */
  availableZ(sessionId: string): number[] {
    return this.sql
      .exec('SELECT DISTINCT z FROM entries WHERE session_id = ? ORDER BY z', sessionId)
      .toArray()
      .map((r) => Number(r['z']))
  }

  /** Aggregates for the dashboards, grouped by source so routes can filter by grant. */
  stats(): {
    bySource: { source: string; sessions: number; costUsd: number; tokens: number; entries: number }[]
    byModel: { source: string; model: string; entries: number }[]
    byTool: { source: string; toolName: string; calls: number }[]
    byDay: { source: string; day: string; sessions: number; costUsd: number }[]
    cacheTokens: { source: string; input: number; cacheRead: number; output: number }[]
  } {
    const bySource = this.sql
      .exec(
        `SELECT source, COUNT(*) AS sessions, SUM(cost_usd) AS costUsd,
                SUM(approx_tokens) AS tokens, SUM(entry_count) AS entries
         FROM sessions GROUP BY source ORDER BY source`,
      )
      .toArray()
      .map((r) => ({
        source: String(r['source']),
        sessions: Number(r['sessions']),
        costUsd: Number(r['costUsd'] ?? 0),
        tokens: Number(r['tokens'] ?? 0),
        entries: Number(r['entries'] ?? 0),
      }))

    const byModel = this.sql
      .exec(
        `SELECT s.source AS source, e.model AS model, COUNT(*) AS entries
         FROM entries e JOIN sessions s ON s.session_id = e.session_id
         WHERE e.model IS NOT NULL GROUP BY s.source, e.model ORDER BY entries DESC`,
      )
      .toArray()
      .map((r) => ({
        source: String(r['source']),
        model: String(r['model']),
        entries: Number(r['entries']),
      }))

    // Tool counts come from the published `Metrics` records, not recomputed from
    // `entries`. The Metrics records are the field-algebra output that was actually
    // committed to the collection, so reading them is what keeps this dashboard and
    // the collection from disagreeing — and it counts *invocations*, not results.
    const toolBySource = new Map<string, Map<string, number>>()
    for (const row of this.sql
      .exec(
        `SELECT s.source AS source, m.data_json AS dataJson
         FROM metrics m JOIN sessions s ON s.session_id = m.scope_id
         WHERE m.scope = 'session'`,
      )
      .toArray()) {
      const source = String(row['source'])
      const data = JSON.parse(String(row['dataJson'])) as { toolCalls?: Record<string, number> }
      const acc = toolBySource.get(source) ?? new Map<string, number>()
      for (const [tool, calls] of Object.entries(data.toolCalls ?? {})) {
        acc.set(tool, (acc.get(tool) ?? 0) + calls)
      }
      toolBySource.set(source, acc)
    }
    const byTool = [...toolBySource]
      .flatMap(([source, tools]) =>
        [...tools].map(([toolName, calls]) => ({ source, toolName, calls })),
      )
      .sort((a, b) => b.calls - a.calls)

    const byDay = this.sql
      .exec(
        `SELECT source, substr(started_at, 1, 10) AS day, COUNT(*) AS sessions, SUM(cost_usd) AS costUsd
         FROM sessions WHERE started_at IS NOT NULL GROUP BY source, day ORDER BY day`,
      )
      .toArray()
      .map((r) => ({
        source: String(r['source']),
        day: String(r['day']),
        sessions: Number(r['sessions']),
        costUsd: Number(r['costUsd'] ?? 0),
      }))

    // Read out of the Metrics records rather than recomputed: they are the published
    // field-algebra output, and reproducing the arithmetic here would let the two drift.
    const cacheBySource = new Map<string, { input: number; cacheRead: number; output: number }>()
    for (const row of this.sql
      .exec(
        `SELECT s.source AS source, m.data_json AS dataJson
         FROM metrics m JOIN sessions s ON s.session_id = m.scope_id
         WHERE m.scope = 'session'`,
      )
      .toArray()) {
      const source = String(row['source'])
      const data = JSON.parse(String(row['dataJson'])) as {
        tokens?: { input?: number; cacheRead?: number; output?: number }
      }
      const acc = cacheBySource.get(source) ?? { input: 0, cacheRead: 0, output: 0 }
      acc.input += data.tokens?.input ?? 0
      acc.cacheRead += data.tokens?.cacheRead ?? 0
      acc.output += data.tokens?.output ?? 0
      cacheBySource.set(source, acc)
    }

    return {
      bySource,
      byModel,
      byTool,
      byDay,
      cacheTokens: [...cacheBySource].map(([source, t]) => ({ source, ...t })),
    }
  }

  sessionLinks(): { originSessionId: string; childSessionId: string; specialistId: string | null }[] {
    return this.sql
      .exec(
        `SELECT origin_session_id AS originSessionId, child_session_id AS childSessionId,
                specialist_id AS specialistId FROM session_links`,
      )
      .toArray() as unknown as {
      originSessionId: string
      childSessionId: string
      specialistId: string | null
    }[]
  }

  /**
   * Full-text search over entry text, with facets.
   *
   * Returns hits *and* the counts per kind, per tool and per session for the whole
   * match set — not just the page — so the UI can offer filters that say how much
   * they would find. Facets are computed over the unfiltered match set on purpose:
   * a filter list that hides the options with results is worse than no filter list.
   */
  search(
    query: string,
    opts: { limit: number; kind?: string | undefined; tool?: string | undefined; sessionId?: string | undefined },
  ): {
    hits: {
      recordId: string
      sessionId: string
      sessionTitle: string | null
      source: string
      seq: number
      kind: string
      toolName: string | null
      timestamp: string | null
      snippet: string
    }[]
    total: number
    facets: {
      kinds: { value: string; count: number }[]
      tools: { value: string; count: number }[]
      sessions: { value: string; title: string | null; source: string; count: number }[]
    }
  } {
    const where: string[] = ['entries_fts MATCH ?']
    const args: (string | number)[] = [query]
    if (opts.kind) {
      where.push('e.kind = ?')
      args.push(opts.kind)
    }
    if (opts.tool) {
      where.push('e.tool_name = ?')
      args.push(opts.tool)
    }
    if (opts.sessionId) {
      where.push('e.session_id = ?')
      args.push(opts.sessionId)
    }

    const from = `FROM entries_fts
         JOIN entries e ON e.rowid = entries_fts.rowid
         JOIN sessions s ON s.session_id = e.session_id
         WHERE ${where.join(' AND ')}`

    const hits = this.sql
      .exec(
        `SELECT e.record_id AS recordId, e.session_id AS sessionId, s.title AS sessionTitle,
                s.source AS source, e.seq AS seq, e.kind AS kind, e.tool_name AS toolName,
                e.timestamp AS timestamp,
                snippet(entries_fts, 0, '⟦', '⟧', '…', 26) AS snippet
         ${from}
         ORDER BY rank LIMIT ?`,
        ...args,
        opts.limit,
      )
      .toArray() as unknown as {
      recordId: string
      sessionId: string
      sessionTitle: string | null
      source: string
      seq: number
      kind: string
      toolName: string | null
      timestamp: string | null
      snippet: string
    }[]

    const total = Number(
      this.sql.exec(`SELECT COUNT(*) AS n ${from}`, ...args).toArray()[0]?.['n'] ?? 0,
    )

    // Facets over the *query* alone, so each filter reports what it would find rather
    // than what survives the filters already applied.
    const facetFrom = `FROM entries_fts
         JOIN entries e ON e.rowid = entries_fts.rowid
         JOIN sessions s ON s.session_id = e.session_id
         WHERE entries_fts MATCH ?`

    const kinds = this.sql
      .exec(`SELECT e.kind AS value, COUNT(*) AS n ${facetFrom} GROUP BY e.kind ORDER BY n DESC`, query)
      .toArray()
      .map((r) => ({ value: String(r['value']), count: Number(r['n']) }))

    const tools = this.sql
      .exec(
        `SELECT e.tool_name AS value, COUNT(*) AS n ${facetFrom} AND e.tool_name IS NOT NULL
         GROUP BY e.tool_name ORDER BY n DESC LIMIT 12`,
        query,
      )
      .toArray()
      .map((r) => ({ value: String(r['value']), count: Number(r['n']) }))

    const sessions = this.sql
      .exec(
        `SELECT e.session_id AS value, s.title AS title, s.source AS source, COUNT(*) AS n
         ${facetFrom} GROUP BY e.session_id ORDER BY n DESC LIMIT 20`,
        query,
      )
      .toArray()
      .map((r) => ({
        value: String(r['value']),
        title: (r['title'] as string | null) ?? null,
        source: String(r['source']),
        count: Number(r['n']),
      }))

    return { hits, total, facets: { kinds, tools, sessions } }
  }
}
