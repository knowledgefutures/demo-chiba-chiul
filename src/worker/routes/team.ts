/**
 * The team's Underlay org: what collections exist, and provisioning new layouts.
 *
 * Provisioning is a real write, not a mock. It reconstructs the records this workspace
 * holds and pushes them through the negotiate protocol — which is why the interesting
 * result is `uploaded: 0`: records are global and content-addressed, so a second
 * collection layout over the same sessions costs one manifest and no record bytes.
 */
import { desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import * as schema from '../../db/schema.ts'
import { CHIUL_SCHEMAS } from '../../lib/underlay/schema.ts'
import { UnderlayClient } from '../../lib/underlay/client.ts'
import { db } from '../db.ts'
import type { AppContext, AppEnv } from '../env.ts'
import { HttpError, readBody } from '../http.ts'
import { WORKSPACE_ID, workspaceStub } from '../workspace.ts'

export const team = new Hono<AppEnv>()

/**
 * Only a persona that may read every source may see or change the org.
 *
 * Provisioning publishes *everyone's* records, so a persona that cannot read a source
 * must not be able to copy it into a new collection. That would be a neat way to
 * launder access, and it is the kind of hole `authz.mjs` exists to catch in Hot and Ask.
 */
function requireFullAccess(c: AppContext): void {
  const access = c.get('access')
  const everywhere =
    access.wildcard.detail === 'full' && [...access.bySource.values()].every((v) => v.detail === 'full')
  if (!everywhere) {
    throw new HttpError(403, 'Managing the org needs read access to every source.', {
      hint: 'Switch to a persona with full access — provisioning would otherwise copy sources this persona cannot read.',
      persona: access.persona.label,
    })
  }
}

team.get('/', async (c) => {
  const workspace = c.get('workspace')
  const access = c.get('access')
  const d = db(c)

  const rows = await d
    .select()
    .from(schema.collections)
    .where(eq(schema.collections.workspaceId, WORKSPACE_ID))

  const commits = await d
    .select()
    .from(schema.commitLog)
    .where(eq(schema.commitLog.workspaceId, WORKSPACE_ID))
    .orderBy(desc(schema.commitLog.at))
    .limit(12)

  // Live upstream state, so the page shows what Underlay actually holds rather than
  // what we last wrote down. Degrades to the local catalog if the key is missing.
  let upstream: {
    slug: string
    recordCount: number
    latestVersion: string | null
    public: boolean
  }[] = []
  let upstreamError: string | null = null
  try {
    const client = new UnderlayClient({
      baseUrl: workspace.underlayUrl,
      apiKey: c.env.UNDERLAY_API_KEY,
    })
    const listed = await client.listOrgCollections(workspace.orgSlug)
    upstream = listed.map((col) => ({
      slug: col.slug,
      recordCount: col.recordCount,
      latestVersion: col.latestVersion,
      public: col.public,
    }))
  } catch (err) {
    upstreamError = err instanceof Error ? err.message : String(err)
  }

  return c.json({
    org: {
      slug: workspace.orgSlug,
      underlayUrl: workspace.underlayUrl,
      hasKey: typeof c.env.UNDERLAY_API_KEY === 'string' && c.env.UNDERLAY_API_KEY.length > 0,
    },
    collections: rows.map((r) => ({
      slug: r.slug,
      layout: r.layout,
      version: r.version,
      ark: r.ark,
      recordCount: r.recordCount,
      isPrimary: r.isPrimary,
    })),
    upstream,
    upstreamError,
    commits: commits.map((r) => ({
      slug: r.collectionSlug,
      semver: r.semver,
      uploaded: r.recordsUploaded,
      outcome: r.outcome,
      detail: r.detail,
      at: r.at,
    })),
    canManage: (() => {
      try {
        requireFullAccess(c)
        return true
      } catch {
        return false
      }
    })(),
    persona: access.persona.label,
  })
})

team.post('/provision', async (c) => {
  requireFullAccess(c)

  const workspace = c.get('workspace')
  const { layout, prefix } = await readBody(
    c,
    z.object({
      layout: z.enum(['person', 'repo']),
      prefix: z.string().min(1).max(24).default('chi'),
    }),
  )

  if (!c.env.UNDERLAY_API_KEY) {
    throw new HttpError(400, 'No Underlay API key is configured for this deployment.', {
      hint: 'Set UNDERLAY_API_KEY. Collection creation also requires the key’s user to be a member of the org.',
    })
  }

  const results = await workspaceStub(c).publish({
    underlayUrl: workspace.underlayUrl,
    apiKey: c.env.UNDERLAY_API_KEY,
    orgSlug: workspace.orgSlug,
    layout,
    prefix,
    schemas: CHIUL_SCHEMAS,
  })

  const d = db(c)
  const now = new Date()
  for (const r of results) {
    await d.insert(schema.commitLog).values({
      workspaceId: WORKSPACE_ID,
      collectionSlug: r.slug,
      semver: r.semver,
      recordsUploaded: r.uploaded,
      outcome: r.error ? 'error' : r.unchanged ? 'unchanged' : 'ok',
      detail: r.error ?? null,
      at: now,
    })
    if (!r.error) {
      await d
        .insert(schema.collections)
        .values({
          id: `${WORKSPACE_ID}:${r.slug}`,
          workspaceId: WORKSPACE_ID,
          slug: r.slug,
          layout,
          version: r.semver,
          ark: null,
          recordCount: r.records,
          isPrimary: false,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.collections.id],
          set: { version: r.semver, recordCount: r.records, layout },
        })
    }
  }

  return c.json({
    layout,
    results,
    totalUploaded: results.reduce((n, r) => n + r.uploaded, 0),
    totalRecords: results.reduce((n, r) => n + r.records, 0),
    // Every collection came back byte-identical to what is already stored — the
    // strongest statement this endpoint can make about reconstruction fidelity.
    allUnchanged: results.length > 0 && results.every((r) => r.unchanged === true),
  })
})
