/**
 * Control plane — D1, static binding.
 *
 * What workspaces exist, which Underlay collections they hydrate from, who the demo
 * personas are, and what each persona may see. The session records themselves live in
 * a per-workspace Durable Object, never here.
 *
 * `grants` is the only table doing real work. The rest is catalog.
 */
import { index, integer, primaryKey, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core'

/**
 * A workspace is one view over a set of Underlay collections in one org.
 *
 * Deliberately not a "team": Hot and Ask both have a `teams` table meaning
 * "who may operate this database", which is a different question and would confuse
 * anyone reading across the three.
 */
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** Underlay instance this workspace reads from. */
  underlayUrl: text('underlay_url').notNull(),
  /** Org slug that owns the collections, e.g. `chiba`. */
  orgSlug: text('org_slug').notNull(),
  /** provisioning → hydrating → ready → error */
  status: text('status').notNull().default('provisioning'),
  statusDetail: text('status_detail'),
  /**
   * How often buffered writes are committed to Underlay, in minutes. This is the whole
   * point of the layer: sessions write at app latency, and Underlay gets one version per
   * interval instead of one per turn.
   */
  flushIntervalMinutes: integer('flush_interval_minutes').notNull().default(15),
  autoFlush: integer('auto_flush', { mode: 'boolean' }).notNull().default(false),
  lastFlushAt: integer('last_flush_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
})

/**
 * A collection the workspace hydrates from, and the layout it represents.
 *
 * Several rows may cover the *same* records under different layouts — per-person and
 * per-repo both hold all 65 sessions. That is the point, and it is why hydration
 * deduplicates by record id rather than trusting one row to be the whole truth.
 */
export const collections = sqliteTable(
  'collections',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Collection slug under the workspace's org. */
    slug: text('slug').notNull(),
    /** person | repo — which grouping this collection expresses. */
    layout: text('layout').notNull(),
    /** Semver hydrated from. Pinned: nothing auto-updates. */
    version: text('version'),
    ark: text('ark'),
    recordCount: integer('record_count').notNull().default(0),
    /** Whether this row is the one hydration reads. Only one per workspace. */
    isPrimary: integer('is_primary', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    index('collections_workspace_idx').on(t.workspaceId),
    unique().on(t.workspaceId, t.slug),
  ],
)

/**
 * A demo persona. Stands in for a signed-in identity without needing real accounts.
 *
 * `sourceLabel` is which source this persona *is* (so "my own sessions" resolves), or
 * null for personas that own nothing — a steward or an outsider.
 */
export const personas = sqliteTable(
  'personas',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /** member | steward | outsider — affects presentation, never access. Access is grants. */
    kind: text('kind').notNull(),
    sourceLabel: text('source_label'),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [index('personas_workspace_idx').on(t.workspaceId), unique().on(t.workspaceId, t.label)],
)

/**
 * What a persona may see, and at what resolution.
 *
 * `detail` is deliberately Chi's own z vocabulary rather than a bespoke permission
 * ladder, because the interesting claim is that consent and reduction level are the
 * same axis: "you may read my summaries but not my raw logs" is a z ceiling.
 *
 *   full     — entries at z=0. The raw session.
 *   reduced  — entries at z>=1 only. Summaries, never raw records.
 *   metrics  — Session and Metrics records only. Shape and cost, no content.
 *   none     — not visible at all.
 *
 * Resolution is most-specific-wins: a `source` grant beats an `all` grant. Two grants
 * of the same specificity take the more permissive `detail`, so adding a grant can
 * never silently remove access.
 */
export const grants = sqliteTable(
  'grants',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    personaId: text('persona_id')
      .notNull()
      .references(() => personas.id, { onDelete: 'cascade' }),
    /** all | source */
    scopeKind: text('scope_kind').notNull(),
    /** Source label when scopeKind is `source`; null for `all`. */
    scopeValue: text('scope_value'),
    /** full | reduced | metrics | none */
    detail: text('detail').notNull(),
    /**
     * Whether `private: true` schema fields (currently `Session.cwd`) are readable.
     * Underlay filters these for non-owners of a *public* collection; on a private
     * collection there is no outside reader at all, so on this data the enforcement
     * is here. See the plan, §4.
     */
    seePrivate: integer('see_private', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [
    index('grants_workspace_idx').on(t.workspaceId),
    index('grants_persona_idx').on(t.personaId),
  ],
)

/** One row per hydration attempt. Cheap history, and the only place errors persist. */
export const hydrationLog = sqliteTable(
  'hydration_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    collectionSlug: text('collection_slug'),
    /** ok | error */
    outcome: text('outcome').notNull(),
    recordsRead: integer('records_read').notNull().default(0),
    sessionsBuilt: integer('sessions_built').notNull().default(0),
    detail: text('detail'),
    at: integer('at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [index('hydration_log_workspace_idx').on(t.workspaceId, t.at)],
)

/** Present for Phase 2, unused in Phase 1 — cheap now, a migration later. */
export const commitLog = sqliteTable(
  'commit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    collectionSlug: text('collection_slug').notNull(),
    semver: text('semver'),
    recordsUploaded: integer('records_uploaded').notNull().default(0),
    outcome: text('outcome').notNull(),
    detail: text('detail'),
    at: integer('at', { mode: 'timestamp' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] })],
)

/**
 * A write token for the ingest endpoint.
 *
 * The token is stored **hashed**, with only its first characters kept for display, so a
 * leaked control plane does not hand out write access. Shown to the operator exactly once
 * at creation — the same contract as any API key worth trusting.
 */
export const ingestTokens = sqliteTable(
  'ingest_tokens',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /** SHA-256 of the token. Never the token itself. */
    tokenHash: text('token_hash').notNull(),
    /** Leading characters, for "which token is this" in a list. */
    prefix: text('prefix').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp' }),
    revokedAt: integer('revoked_at', { mode: 'timestamp' }),
    /** Cheap usage signal, so the panel can show the buffer is actually receiving. */
    writes: integer('writes').notNull().default(0),
  },
  (t) => [
    index('ingest_tokens_workspace_idx').on(t.workspaceId),
    unique().on(t.tokenHash),
  ],
)
