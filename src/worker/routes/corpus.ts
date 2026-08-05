/**
 * The corpus, as shape.
 *
 * Returns every session's entries as a string of single-character kind codes — the whole
 * 9,299-entry corpus in about 9 KB. That is what lets the client draw all of it at once
 * and zoom continuously, rather than paging through a list and never seeing the whole.
 *
 * Sessions the persona may not see are omitted and counted, like everywhere else.
 */
import { Hono } from 'hono'

import type { AppEnv } from '../env.ts'
import { canSeeSession, detailFor } from '../grants.ts'
import { workspaceStub } from '../workspace.ts'

export const corpus = new Hono<AppEnv>()

corpus.get('/', async (c) => {
  const access = c.get('access')
  const stub = workspaceStub(c)

  const [marks, sessions, links] = await Promise.all([
    stub.corpusMarks(),
    stub.listSessions(),
    stub.sessionLinks(),
  ])

  const byId = new Map(sessions.map((s) => [s.sessionId, s]))
  const visible = marks.filter((m) => canSeeSession(access, m.source))

  return c.json({
    sessions: visible
      .map((m) => {
        const session = byId.get(m.sessionId)
        const detail = detailFor(access, m.source)
        return {
          sessionId: m.sessionId,
          source: m.source,
          // A title is model-written content, so it follows the same rule as elsewhere:
          // withheld at `metrics`, shown once a persona may read summaries.
          title: detail === 'metrics' ? null : (session?.title ?? null),
          startedAt: session?.startedAt ?? null,
          costUsd: session?.costUsd ?? 0,
          approxTokens: session?.approxTokens ?? 0,
          detail,
          canOpen: detail === 'full' || detail === 'reduced',
          marks: m.marks,
        }
      })
      .sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '')),
    links: links.filter(
      (l) =>
        visible.some((m) => m.sessionId === l.originSessionId) &&
        visible.some((m) => m.sessionId === l.childSessionId),
    ),
    withheld: marks.length - visible.length,
    totalEntries: visible.reduce((n, m) => n + m.marks.length, 0),
  })
})
