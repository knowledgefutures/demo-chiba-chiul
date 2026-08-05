/**
 * chiul — Worker entry point.
 *
 * Control plane in D1, data plane in one SQLite Durable Object. The React SPA is served
 * from Workers Static Assets; only `/api/*` reaches this Worker.
 *
 * Assembly only: the gate, the persona middleware, route mounts, error handlers.
 */
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import { z } from 'zod'

import * as dbSchema from '../db/schema.ts'
import { CHIUL_SCHEMAS } from '../lib/underlay/schema.ts'

import type { AppEnv } from './env.ts'
import { gateConfigured, isUnlocked, lock, setPersona, unlock } from './gate.ts'
import { HttpError, readBody } from './http.ts'
import { corpus } from './routes/corpus.ts'
import { ingest } from './routes/ingest.ts'
import { sessions } from './routes/sessions.ts'
import { stats } from './routes/stats.ts'
import { team } from './routes/team.ts'
import {
  accessFor,
  ensureWorkspace,
  listPersonas,
  resolveCurrentAccess,
  WORKSPACE_ID,
  workspaceStub,
} from './workspace.ts'

export { Workspace } from '../do/workspace.ts'

const app = new Hono<AppEnv>()

app.get('/api/health', (c) =>
  c.json({ ok: true, underlay: c.env.UNDERLAY_URL, org: c.env.UNDERLAY_ORG }),
)

/**
 * Gate status. Unauthenticated on purpose — the landing page has to know whether to ask
 * for a password, and "is there a lock on this door" is not a secret.
 */
app.get('/api/gate', async (c) => {
  return c.json({ configured: gateConfigured(c), unlocked: await isUnlocked(c) })
})

app.post('/api/gate', async (c) => {
  const { password } = await readBody(c, z.object({ password: z.string().min(1) }))
  if (!(await unlock(c, password))) {
    if (!gateConfigured(c)) {
      throw new HttpError(503, 'This deployment has no DEMO_PASSWORD set, so nobody can enter.')
    }
    throw new HttpError(401, 'Incorrect password')
  }
  return c.json({ unlocked: true })
})

app.post('/api/gate/lock', (c) => {
  lock(c)
  return c.json({ unlocked: false })
})

/**
 * Everything below the gate — with one deliberate exception.
 *
 * `POST /api/ingest` is a **machine** surface authenticated by a write token, not by the
 * demo cookie. It must not sit behind the gate (a client writing session logs has no
 * browser session) and it must not accept the cookie either, or any page a viewer visits
 * could write on their behalf. So it gets the workspace but never a persona: there is no
 * `access` to speak of, and nothing in that handler reads one.
 *
 * The operator routes under `/api/ingest/*` — minting tokens, changing the interval,
 * flushing — stay behind the gate, because those are decisions, not writes.
 */
const isMachineIngest = (c: { req: { path: string; method: string } }) =>
  c.req.path === '/api/ingest' && c.req.method === 'POST'

app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/gate') || c.req.path === '/api/health') return next()

  if (isMachineIngest(c)) {
    c.set('workspace', await ensureWorkspace(c))
    return next()
  }

  if (!(await isUnlocked(c))) throw new HttpError(401, 'Locked')

  c.set('workspace', await ensureWorkspace(c))
  c.set('access', await resolveCurrentAccess(c))
  return next()
})

/**
 * Who am I, and who could I be.
 *
 * Returns the full persona roster with each one's grants, because the roster *is* the
 * demo — hiding the other personas would make the switcher look like a login.
 */
app.get('/api/me', async (c) => {
  const access = c.get('access')
  const personas = await listPersonas(c)

  const roster = await Promise.all(
    personas.map(async (p) => {
      const a = await accessFor(c, p.id)
      return {
        id: p.id,
        label: p.label,
        kind: p.kind,
        sourceLabel: p.sourceLabel,
        description: p.description,
        current: p.id === access.persona.id,
        grants: {
          wildcard: a.wildcard,
          bySource: [...a.bySource].map(([source, v]) => ({ source, ...v })),
        },
      }
    }),
  )

  return c.json({
    persona: {
      id: access.persona.id,
      label: access.persona.label,
      kind: access.persona.kind,
      sourceLabel: access.persona.sourceLabel,
    },
    personas: roster,
    /**
     * Said out loud in the API, not just in the UI copy: this is a demo curtain, not a
     * security boundary. Anyone holding the link can select any persona.
     */
    disclaimer:
      'Demo only. One shared password gates the whole site and any visitor may select any ' +
      'persona. Access is genuinely enforced server-side per persona, but the persona itself ' +
      'is a choice, not an identity.',
  })
})

app.post('/api/me/persona', async (c) => {
  const { personaId } = await readBody(c, z.object({ personaId: z.string().min(1) }))
  // Validates the persona exists before signing it into a cookie.
  const access = await accessFor(c, personaId)
  await setPersona(c, personaId)
  return c.json({ persona: { id: access.persona.id, label: access.persona.label } })
})

// --- Workspace ---

app.get('/api/workspace', async (c) => {
  const workspace = c.get('workspace')
  const status = await workspaceStub(c).status()
  return c.json({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      underlayUrl: workspace.underlayUrl,
      orgSlug: workspace.orgSlug,
    },
    ...status,
  })
})

/**
 * Hydrate from the Underlay collections.
 *
 * Reads the per-repo layout, which holds all 65 sessions in one collection — the
 * per-person layouts cover the same records, so one read is enough and the others exist
 * to prove a point about access, not to be read separately.
 */
app.post('/api/workspace/hydrate', async (c) => {
  const workspace = c.get('workspace')
  const body = await readBody(
    c,
    z.object({
      collections: z
        .array(z.object({ slug: z.string(), version: z.string() }))
        .min(1)
        .optional(),
    }),
  )

  const collections = body.collections ?? [
    { slug: c.env.UNDERLAY_PRIMARY_COLLECTION, version: c.env.UNDERLAY_PRIMARY_VERSION },
  ]

  const result = await workspaceStub(c).hydrate({
    underlayUrl: workspace.underlayUrl,
    apiKey: c.env.UNDERLAY_API_KEY ?? null,
    orgSlug: workspace.orgSlug,
    collections,
  })

  return c.json({ ok: true, ...result })
})

app.route('/api/sessions', sessions)
app.route('/api/stats', stats)
app.route('/api/corpus', corpus)
app.route('/api/ingest', ingest)
app.route('/api/team', team)

app.notFound((c) =>
  c.req.path.startsWith('/api/')
    ? c.json({ error: 'Not found', statusCode: 404 }, 404)
    : c.text('Not found', 404),
)

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message, statusCode: err.status, ...err.extra }, err.status)
  }
  console.error('[chiul] unhandled', err)
  return c.json({ error: err instanceof Error ? err.message : String(err), statusCode: 500 }, 500)
})

/**
 * The interval, as a cron trigger.
 *
 * Flushes only when auto-flush is on, the buffer is non-empty, and the configured interval
 * has actually elapsed — the cron fires on a fixed schedule, so the interval is enforced
 * here rather than by the schedule. Errors are logged and swallowed: a failed flush must
 * leave the buffer intact for the next run, never drop it.
 */
async function scheduled(_event: ScheduledController, env: Env): Promise<void> {
  const d = drizzle(env.DB, { schema: dbSchema })
  const [workspace] = await d
    .select()
    .from(dbSchema.workspaces)
    .where(eq(dbSchema.workspaces.id, WORKSPACE_ID))
    .limit(1)

  if (!workspace || !workspace.autoFlush || !env.UNDERLAY_API_KEY) return

  const due =
    workspace.lastFlushAt === null ||
    Date.now() - workspace.lastFlushAt.getTime() >= workspace.flushIntervalMinutes * 60_000
  if (!due) return

  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(WORKSPACE_ID))
  if ((await stub.pendingCount()) === 0) return

  try {
    const results = await stub.publish({
      underlayUrl: workspace.underlayUrl,
      apiKey: env.UNDERLAY_API_KEY,
      orgSlug: workspace.orgSlug,
      layout: 'repo',
      prefix: 'chi',
      schemas: CHIUL_SCHEMAS,
    })
    const now = new Date()
    await d
      .update(dbSchema.workspaces)
      .set({ lastFlushAt: now, updatedAt: now })
      .where(eq(dbSchema.workspaces.id, WORKSPACE_ID))
    for (const r of results) {
      await d.insert(dbSchema.commitLog).values({
        workspaceId: WORKSPACE_ID,
        collectionSlug: r.slug,
        semver: r.semver,
        recordsUploaded: r.uploaded,
        outcome: r.error ? 'error' : r.unchanged ? 'unchanged' : 'ok',
        detail: r.error ?? 'scheduled flush',
        at: now,
      })
    }
  } catch (err) {
    console.error('[chiul] scheduled flush failed; buffer left intact', err)
  }
}

export default { fetch: app.fetch, scheduled }
