/**
 * Underlay read/write client — the negotiate push protocol and the version read APIs.
 *
 * The push is four steps, and step 2 is the one that matters:
 *
 *   1. POST .../versions/negotiate       send schemas + a manifest of {id, type, hash}
 *   2. ← needed_records                  the hashes the server does *not* already have
 *   3. POST .../negotiate/:id/records    upload only those, as JSONL
 *   4. POST .../negotiate/:id/commit     create the immutable version
 *
 * Step 2 is why publishing the same corpus under a second collection layout costs
 * ~zero bytes: every hash is already present, `needed_records` comes back empty,
 * and all that gets written is a new manifest.
 */
import { hashRecord } from './hash.ts'
import type { UnderlayRecord } from '../chi/project.ts'

export type UnderlayClientOptions = {
  baseUrl: string
  apiKey?: string | undefined
  /** Records per upload batch. Capped upstream at 10,000; also bounded by bytes below. */
  batchSize?: number
  /** Bytes per upload batch. Some tool-result entries run to 64 KB on their own. */
  batchBytes?: number
}

export type NegotiateResult = {
  sessionId: string
  neededRecords: string[]
  totalRecords: number
  alreadyHaveRecords: number
}

export type CommitResult = { semver: string; recordCount: number; uploaded: number }

/**
 * Fields are declared and assigned explicitly rather than as constructor parameter
 * properties: the tools run under Node's strip-only TypeScript mode, which rejects
 * that syntax (it would require emitting code, not just removing types). Same rule
 * applies to enums, namespaces, and decorators anywhere under `src/lib`.
 */
export class UnderlayError extends Error {
  status: number
  body: string

  constructor(status: number, body: string, message: string) {
    super(message)
    this.name = 'UnderlayError'
    this.status = status
    this.body = body
  }
}

export class UnderlayClient {
  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly batchSize: number
  private readonly batchBytes: number

  constructor(opts: UnderlayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.apiKey = opts.apiKey
    this.batchSize = opts.batchSize ?? 2_000
    this.batchBytes = opts.batchBytes ?? 4 * 1024 * 1024
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      ...extra,
    }
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.baseUrl}${path}`, init)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new UnderlayError(
        res.status,
        body,
        `${init.method ?? 'GET'} ${path} → ${res.status}: ${body.slice(0, 400)}`,
      )
    }
    return res
  }

  private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
    return (await this.request(path, init)).json() as Promise<T>
  }

  /**
   * Create a collection. Private by default and on purpose: the corpus terms
   * forbid redistribution, and privacy is evaluated per collection, so a single
   * public layout over the same records would expose all of them (see the plan,
   * §5 "one sharp edge").
   */
  async createCollection(
    owner: string,
    slug: string,
    opts: { name?: string; public?: boolean } = {},
  ): Promise<{ id: string; ark?: string; existed: boolean }> {
    try {
      const created = await this.json<{ id: string; ark?: string }>(
        `/api/accounts/${owner}/collections`,
        {
          method: 'POST',
          headers: this.headers({ 'content-type': 'application/json' }),
          body: JSON.stringify({ slug, name: opts.name ?? slug, public: opts.public ?? false }),
        },
      )
      return { ...created, existed: false }
    } catch (err) {
      if (err instanceof UnderlayError && err.status === 409) {
        const existing = await this.getCollection(owner, slug)
        return { id: existing.id, existed: true }
      }
      throw err
    }
  }

  async getCollection(owner: string, slug: string): Promise<{ id: string; public: boolean }> {
    return this.json(`/api/collections/${owner}/${slug}`, { headers: this.headers() })
  }

  async latestVersion(owner: string, slug: string): Promise<{ semver: string } | null> {
    try {
      return await this.json(`/api/collections/${owner}/${slug}/versions/latest`, {
        headers: this.headers(),
      })
    } catch (err) {
      if (err instanceof UnderlayError && err.status === 404) return null
      throw err
    }
  }

  /**
   * Push records as a new version. Returns what was actually uploaded, which is
   * the number the "second layout costs nothing" demo turns on.
   */
  async push(
    owner: string,
    slug: string,
    records: readonly UnderlayRecord[],
    opts: {
      schemas: Record<string, Record<string, unknown>>
      message?: string
      baseVersion?: string | null
      appId?: string
    },
  ): Promise<CommitResult> {
    const hashed = await Promise.all(
      records.map(async (record) => ({ record, ...(await hashRecord(record)) })),
    )

    const negotiated = await this.json<{
      session_id: string
      needed_records: string[]
      total_records: number
      already_have_records: number
    }>(`/api/collections/${owner}/${slug}/versions/negotiate`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify({
        base_version: opts.baseVersion ?? null,
        schemas: opts.schemas,
        manifest: hashed.map(({ record, hash }) => ({ id: record.id, type: record.type, hash })),
        ...(opts.message === undefined ? {} : { message: opts.message }),
        ...(opts.appId === undefined ? {} : { app_id: opts.appId }),
      }),
    })

    const needed = new Set(negotiated.needed_records)
    // The manifest may legitimately contain two entries with the same hash (an
    // identical record under two ids); upload the body once.
    const seen = new Set<string>()
    const toUpload = hashed.filter(({ hash }) => {
      if (!needed.has(hash) || seen.has(hash)) return false
      seen.add(hash)
      return true
    })

    for (const batch of batched(toUpload, this.batchSize, this.batchBytes)) {
      await this.request(
        `/api/collections/${owner}/${slug}/versions/negotiate/${negotiated.session_id}/records`,
        {
          method: 'POST',
          headers: this.headers({ 'content-type': 'application/x-ndjson' }),
          body: batch.map(({ canonical }) => canonical).join('\n'),
        },
      )
    }

    const committed = await this.json<{ version?: { semver: string }; semver?: string }>(
      `/api/collections/${owner}/${slug}/versions/negotiate/${negotiated.session_id}/commit`,
      { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: '{}' },
    )

    return {
      semver: committed.version?.semver ?? committed.semver ?? 'unknown',
      recordCount: records.length,
      uploaded: toUpload.length,
    }
  }

  /**
   * Every record in a version, via keyset paging. This is the read side of the
   * round-trip gate: it must see only what any reader of the collection sees.
   */
  async readAllRecords(
    owner: string,
    slug: string,
    version: string,
    opts: { type?: string; pageSize?: number } = {},
  ): Promise<UnderlayRecord[]> {
    const pageSize = opts.pageSize ?? 1_000
    const out: UnderlayRecord[] = []
    let after: string | undefined

    for (;;) {
      const params = new URLSearchParams({ limit: String(pageSize) })
      if (after !== undefined) params.set('after', after)
      if (opts.type !== undefined) params.set('type', opts.type)

      // Paging state is nested under `pagination` — verified against a live
      // instance rather than assumed. `hasMore` is authoritative: a final page can
      // still carry a `nextCursor`.
      const page = await this.json<{
        records: { id: string; type: string; data: Record<string, unknown>; hash: string }[]
        pagination: { limit: number; hasMore: boolean; nextCursor: string | null; total: number }
      }>(`/api/collections/${owner}/${slug}/versions/${version}/records?${params}`, {
        headers: this.headers(),
      })

      out.push(...page.records)
      if (!page.pagination.hasMore || !page.pagination.nextCursor) break
      if (page.records.length === 0) break
      after = page.pagination.nextCursor
    }

    return out
  }
}

/** Batch by count *and* bytes — a single 64 KB tool result can blow a count-only cap. */
export function* batched<T extends { canonical: string }>(
  items: readonly T[],
  maxCount: number,
  maxBytes: number,
): Generator<T[]> {
  let batch: T[] = []
  let bytes = 0
  for (const item of items) {
    const size = item.canonical.length + 1
    if (batch.length > 0 && (batch.length >= maxCount || bytes + size > maxBytes)) {
      yield batch
      batch = []
      bytes = 0
    }
    batch.push(item)
    bytes += size
  }
  if (batch.length > 0) yield batch
}
