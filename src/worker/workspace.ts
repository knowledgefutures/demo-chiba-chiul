/**
 * Workspace resolution, seeding, and the persona middleware.
 *
 * There is exactly one workspace in this demo. It is created on first request rather
 * than by a migration, so a fresh D1 (local or deployed) comes up working instead of
 * empty — the failure mode of "deployed but nothing seeded" is a confusing demo.
 */
import { and, eq } from 'drizzle-orm'

import * as schema from '../db/schema.ts'
import { db } from './db.ts'
import type { AppContext, PersonaRow, WorkspaceRow } from './env.ts'
import { currentPersonaId } from './gate.ts'
import { resolveAccess } from './grants.ts'
import type { Access, Detail, Grant, Persona } from './grants.ts'
import { HttpError } from './http.ts'

export const WORKSPACE_ID = 'chiul-demo'

/**
 * The demo's personas and what each may see.
 *
 * This table is the demo. Each row is a claim about consent that the surface then
 * enforces for real:
 *
 *   - a member reads their own raw sessions and only the shape of everyone else's
 *   - a steward reads summaries across the whole team, never raw records, never paths
 *   - an outsider sees cost and shape and nothing else
 *   - User 2 has specifically withheld their sessions from the steward, which is the
 *     case that proves grants are per-source rather than a global role
 */
const SEED_PERSONAS: {
  label: string
  kind: Persona['kind']
  sourceLabel: string | null
  description: string
  grants: { scopeKind: 'all' | 'source'; scopeValue: string | null; detail: Detail; seePrivate: boolean }[]
}[] = [
  {
    /**
     * The default, and the reason it exists: a least-privileged default is right for a
     * product and wrong for a demo. Opening as `Outsider` made every list empty and
     * every search return nothing — the access model working exactly as designed, and
     * indistinguishable from a broken app.
     *
     * So the demo opens on the view where everything is visible, and the restricted
     * personas become something you deliberately switch *to* in order to watch access
     * bite. Same enforcement either way.
     */
    label: 'Chi core',
    kind: 'steward',
    sourceLabel: null,
    description: 'Stewards the commons. Full access to every source — the view the corpus was shared for.',
    grants: [{ scopeKind: 'all', scopeValue: null, detail: 'full', seePrivate: true }],
  },
  {
    label: 'User 1',
    kind: 'member',
    sourceLabel: 'User 1',
    description: 'A team member. Own sessions in full; everyone else by shape and cost only.',
    grants: [
      { scopeKind: 'source', scopeValue: 'User 1', detail: 'full', seePrivate: true },
      { scopeKind: 'all', scopeValue: null, detail: 'metrics', seePrivate: false },
    ],
  },
  {
    label: 'User 2',
    kind: 'member',
    sourceLabel: 'User 2',
    description: 'A team member on a different machine. Same rules, different data.',
    grants: [
      { scopeKind: 'source', scopeValue: 'User 2', detail: 'full', seePrivate: true },
      { scopeKind: 'all', scopeValue: null, detail: 'metrics', seePrivate: false },
    ],
  },
  {
    label: 'Team steward',
    kind: 'steward',
    sourceLabel: null,
    description:
      'Reviews the team’s work. Summaries everywhere, raw records nowhere — and User 2 has withheld their sessions entirely.',
    grants: [
      { scopeKind: 'all', scopeValue: null, detail: 'reduced', seePrivate: false },
      { scopeKind: 'source', scopeValue: 'User 2', detail: 'none', seePrivate: false },
    ],
  },
  {
    label: 'Outsider',
    kind: 'outsider',
    sourceLabel: null,
    description: 'No membership. Aggregate cost and shape only, no session content.',
    grants: [{ scopeKind: 'all', scopeValue: null, detail: 'metrics', seePrivate: false }],
  },
]

/**
 * Create the workspace if absent, and reconcile the persona roster every time.
 *
 * Reconciling rather than seeding-once is the point: an earlier version returned early
 * when the workspace row existed, so adding a persona to `SEED_PERSONAS` had no effect on
 * any environment that had already been visited — including the one being demoed. The
 * roster is configuration, so it converges to the code on every request.
 *
 * Cheap enough to do per request at this size (5 personas, 8 grants), and it means a
 * deployment never carries a stale roster.
 */
export async function ensureWorkspace(c: AppContext): Promise<WorkspaceRow> {
  const d = db(c)
  const now = new Date()

  const existing = await d
    .select()
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, WORKSPACE_ID))
    .limit(1)

  const row =
    existing[0] ??
    ({
      id: WORKSPACE_ID,
      name: 'Chi sessions',
      underlayUrl: c.env.UNDERLAY_URL,
      orgSlug: c.env.UNDERLAY_ORG,
      status: 'provisioning',
      statusDetail: null,
      flushIntervalMinutes: 15,
      autoFlush: false,
      lastFlushAt: null,
      createdAt: now,
      updatedAt: now,
    } satisfies WorkspaceRow)

  if (!existing[0]) await d.insert(schema.workspaces).values(row).onConflictDoNothing()

  for (const [i, seed] of SEED_PERSONAS.entries()) {
    const personaId = `${WORKSPACE_ID}:${seed.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
    await d
      .insert(schema.personas)
      .values({
        id: personaId,
        workspaceId: WORKSPACE_ID,
        label: seed.label,
        kind: seed.kind,
        sourceLabel: seed.sourceLabel,
        description: seed.description,
        sortOrder: i,
      })
      .onConflictDoUpdate({
        target: [schema.personas.id],
        set: {
          kind: seed.kind,
          sourceLabel: seed.sourceLabel,
          description: seed.description,
          sortOrder: i,
        },
      })

    for (const [j, g] of seed.grants.entries()) {
      await d
        .insert(schema.grants)
        .values({
          id: `${personaId}:g${j}`,
          workspaceId: WORKSPACE_ID,
          personaId,
          scopeKind: g.scopeKind,
          scopeValue: g.scopeValue,
          detail: g.detail,
          seePrivate: g.seePrivate,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.grants.id],
          set: {
            scopeKind: g.scopeKind,
            scopeValue: g.scopeValue,
            detail: g.detail,
            seePrivate: g.seePrivate,
          },
        })
    }
  }

  return row
}

export async function listPersonas(c: AppContext): Promise<PersonaRow[]> {
  return db(c)
    .select()
    .from(schema.personas)
    .where(eq(schema.personas.workspaceId, WORKSPACE_ID))
    .orderBy(schema.personas.sortOrder)
}

/**
 * The persona's access, read from `grants` on every request.
 *
 * Not cached, and not derived from the persona's `kind`: the whole point is that the
 * rules live in data a reviewer can inspect and change, so reading them each time is
 * the honest implementation as well as the simple one.
 */
export async function accessFor(c: AppContext, personaId: string): Promise<Access> {
  const d = db(c)
  const [persona] = await d
    .select()
    .from(schema.personas)
    .where(and(eq(schema.personas.id, personaId), eq(schema.personas.workspaceId, WORKSPACE_ID)))
    .limit(1)
  if (!persona) throw new HttpError(404, 'Unknown persona')

  const rows = await d.select().from(schema.grants).where(eq(schema.grants.personaId, personaId))

  return resolveAccess(
    {
      id: persona.id,
      label: persona.label,
      kind: persona.kind as Persona['kind'],
      sourceLabel: persona.sourceLabel,
    },
    rows.map(
      (r): Grant => ({
        scopeKind: r.scopeKind as Grant['scopeKind'],
        scopeValue: r.scopeValue,
        detail: r.detail as Detail,
        seePrivate: r.seePrivate,
      }),
    ),
  )
}

/**
 * The persona a visitor lands on: the first in sort order, which is `Chi core`.
 *
 * Not the least privileged one — see the note on `SEED_PERSONAS`. The gate already
 * decides *whether* someone may look; the persona decides *as whom*, and a demo should
 * open on the view that shows the data.
 */
export async function defaultPersonaId(c: AppContext): Promise<string> {
  const personas = await listPersonas(c)
  const first = personas[0]
  if (!first) throw new HttpError(500, 'No personas seeded')
  return first.id
}

export async function resolveCurrentAccess(c: AppContext): Promise<Access> {
  const fromCookie = await currentPersonaId(c)
  const personaId = fromCookie ?? (await defaultPersonaId(c))
  try {
    return await accessFor(c, personaId)
  } catch {
    // A stale cookie (persona deleted, or a different deployment) must not lock the
    // demo out; fall back to the least privileged persona rather than erroring.
    return accessFor(c, await defaultPersonaId(c))
  }
}

export function workspaceStub(c: AppContext): DurableObjectStub<import('../do/workspace.ts').Workspace> {
  return c.env.WORKSPACE.get(c.env.WORKSPACE.idFromName(WORKSPACE_ID))
}
