/**
 * Sessions and entries, filtered by the current persona's grants.
 *
 * Every list here is filtered **server-side**. A persona with `metrics` detail does not
 * receive session content and then have the client hide it — the bytes never leave the
 * Worker. That is the difference between demonstrating an access model and drawing one.
 */
import { Hono } from 'hono'

import type { AppEnv } from '../env.ts'
import {
  canReadEntries,
  canReadReduced,
  canSeeSession,
  detailFor,
  explainDetail,
  filterSession,
} from '../grants.ts'
import { HttpError, intParam } from '../http.ts'
import { workspaceStub } from '../workspace.ts'

export const sessions = new Hono<AppEnv>()

sessions.get('/', async (c) => {
  const access = c.get('access')
  const all = await workspaceStub(c).listSessions()

  const visible = all.filter((s) => canSeeSession(access, s.source))
  const rows = visible.map((s) => {
    const detail = detailFor(access, s.source)
    const filtered = filterSession(
      { ...s, models: JSON.parse(s.models) as string[] },
      access,
      s.source,
    )
    return {
      ...filtered,
      detail,
      // `metrics` means shape and cost without content. A title is content — it is a
      // model-written summary of what was discussed — so it goes too, and the row says
      // why rather than showing a blank.
      title: detail === 'metrics' ? null : filtered.title,
      canOpen: detail === 'full' || detail === 'reduced',
    }
  })

  return c.json({
    sessions: rows,
    // The counts a reader needs to understand what they are *not* seeing. An empty or
    // short list with no explanation is the thing this demo is trying to avoid.
    visibility: {
      total: all.length,
      visible: visible.length,
      withheld: all.length - visible.length,
      persona: access.persona.label,
      bySource: [...new Set(all.map((s) => s.source))].sort().map((source) => ({
        source,
        detail: detailFor(access, source),
        explanation: explainDetail(detailFor(access, source), source),
        sessions: all.filter((s) => s.source === source).length,
      })),
    },
  })
})

sessions.get('/:id', async (c) => {
  const access = c.get('access')
  const stub = workspaceStub(c)
  const session = await stub.getSession(c.req.param('id'))
  if (!session) throw new HttpError(404, 'Session not found')

  const detail = detailFor(access, session.source)
  if (detail === 'none') {
    throw new HttpError(403, explainDetail(detail, session.source), { source: session.source })
  }
  if (detail === 'metrics') {
    throw new HttpError(403, explainDetail(detail, session.source), {
      source: session.source,
      hint: 'This persona may see the shape and cost of this session, but not its content.',
    })
  }

  const availableZ = await stub.availableZ(session.sessionId)
  const links = (await stub.sessionLinks()).filter(
    (l) => l.originSessionId === session.sessionId || l.childSessionId === session.sessionId,
  )

  return c.json({
    session: filterSession(
      { ...session, models: JSON.parse(session.models) as string[] },
      access,
      session.source,
    ),
    detail,
    availableZ,
    /**
     * Which z levels this persona may actually read, versus which exist. A steward at
     * `reduced` sees that z=0 exists and is closed to them — more informative than
     * omitting it, and it is what makes consent-as-z-ceiling legible.
     */
    readableZ: availableZ.filter((z) =>
      z === 0 ? canReadEntries(access, session.source) : canReadReduced(access, session.source),
    ),
    links,
  })
})

sessions.get('/:id/entries', async (c) => {
  const access = c.get('access')
  const stub = workspaceStub(c)
  const session = await stub.getSession(c.req.param('id'))
  if (!session) throw new HttpError(404, 'Session not found')

  const z = intParam(c.req.query('z'), 0, 10)
  const limit = intParam(c.req.query('limit'), 100, 500)
  const offset = intParam(c.req.query('offset'), 0, 1_000_000)

  const allowed = z === 0 ? canReadEntries(access, session.source) : canReadReduced(access, session.source)
  if (!allowed) {
    throw new HttpError(403, explainDetail(detailFor(access, session.source), session.source), {
      requestedZ: z,
      hint:
        z === 0
          ? 'Raw records (z=0) are closed to this persona. Try a reduced level.'
          : 'This persona may not read this reduction level.',
    })
  }

  const entries = await stub.listEntries(session.sessionId, z, limit, offset)
  return c.json({
    entries: entries.map((e) => ({
      recordId: e.recordId,
      seq: e.seq,
      z: e.z,
      entryType: e.entryType,
      role: e.role,
      toolName: e.toolName,
      model: e.model,
      timestamp: e.timestamp,
      entry: JSON.parse(e.entryJson) as unknown,
    })),
    z,
    limit,
    offset,
    total: session.entryCount,
  })
})
