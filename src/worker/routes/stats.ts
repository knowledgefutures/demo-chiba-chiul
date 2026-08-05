/**
 * Dashboard aggregates, and search.
 *
 * Aggregates are filtered by grant like everything else, but the rule is different from
 * sessions: `metrics` detail is *enough* to be counted here. That is the point of having
 * `metrics` as a level — an outsider can be told what the team costs without being shown
 * a word of what they said.
 */
import { Hono } from 'hono'

import type { AppEnv } from '../env.ts'
import { canReadEntries, canSeeSession, detailFor } from '../grants.ts'
import { intParam } from '../http.ts'
import { workspaceStub } from '../workspace.ts'

export const stats = new Hono<AppEnv>()

stats.get('/', async (c) => {
  const access = c.get('access')
  const raw = await workspaceStub(c).stats()
  const allowed = (source: string) => canSeeSession(access, source)

  const bySource = raw.bySource.filter((r) => allowed(r.source))
  const withheldSources = raw.bySource.filter((r) => !allowed(r.source)).map((r) => r.source)

  return c.json({
    totals: {
      sessions: bySource.reduce((n, r) => n + r.sessions, 0),
      costUsd: bySource.reduce((n, r) => n + r.costUsd, 0),
      entries: bySource.reduce((n, r) => n + r.entries, 0),
      tokens: bySource.reduce((n, r) => n + r.tokens, 0),
    },
    bySource,
    byModel: raw.byModel.filter((r) => allowed(r.source)),
    byTool: raw.byTool.filter((r) => allowed(r.source)),
    byDay: raw.byDay.filter((r) => allowed(r.source)),
    cacheTokens: raw.cacheTokens.filter((r) => allowed(r.source)),
    links: (await workspaceStub(c).sessionLinks()).length,
    // Named, not silently dropped: a dashboard that quietly excludes a third of the
    // team reads as a complete picture when it is not.
    withheldSources,
  })
})

/**
 * Search is gated at `full`, not `reduced`.
 *
 * A snippet is raw session text — it is the most direct content there is. Letting a
 * `reduced` persona search raw entries would route around the very thing their grant
 * withholds, which is the sort of hole that makes an access model theatre.
 */
stats.get('/search', async (c) => {
  const access = c.get('access')
  const q = (c.req.query('q') ?? '').trim()
  const stub = workspaceStub(c)
  const all = await stub.listSessions()
  const sources = [...new Set(all.map((s) => s.source))].sort()
  const detailBySource = sources.map((source) => ({ source, detail: detailFor(access, source) }))
  const searchableSources = sources.filter((source) => canReadEntries(access, source))

  if (q.length < 2) {
    return c.json({
      query: q,
      results: [],
      total: 0,
      facets: { kinds: [], tools: [], sessions: [] },
      searchableSources,
      detailBySource,
      withheldHits: 0,
    })
  }

  const { hits, total, facets } = await stub.search(q, {
    limit: intParam(c.req.query('limit'), 60, 200),
    kind: c.req.query('kind'),
    tool: c.req.query('tool'),
    sessionId: c.req.query('session'),
  })

  const readable = hits.filter((h) => canReadEntries(access, h.source))

  return c.json({
    query: q,
    results: readable,
    total,
    // Facet counts are over the whole match set, including sources this persona cannot
    // read — so they are trimmed here too, or the filter counts would advertise
    // records that can never be returned.
    facets: {
      kinds: facets.kinds,
      tools: facets.tools,
      sessions: facets.sessions.filter((s) => canReadEntries(access, s.source)),
    },
    searchableSources,
    detailBySource,
    withheldHits: hits.length - readable.length,
  })
})
