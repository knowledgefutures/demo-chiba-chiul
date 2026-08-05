/**
 * The write side: a fast buffer in front of Underlay.
 *
 * The point of this layer. Underlay versions are commits — a manifest plus a version hash —
 * which suits batches and not per-turn appends. So a session writes here at app latency,
 * the writes land in a Durable Object immediately, and Underlay receives **one version per
 * flush interval** instead of one per turn. Content addressing then means a flush uploads
 * only the records that are actually new.
 *
 * Two surfaces, deliberately different:
 *
 *   POST /api/ingest       machine, `Authorization: Bearer <write token>`. Never a session
 *                          cookie: a browser must not be able to write on a viewer's behalf.
 *   /api/ingest/tokens…    operator, behind the gate and gated on full read access, because
 *                          minting a write credential is not a viewer's decision.
 */
import { and, desc, eq, isNull } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'

import * as schema from '../../db/schema.ts'
import { CHIUL_SCHEMAS } from '../../lib/underlay/schema.ts'
import { db } from '../db.ts'
import type { AppContext, AppEnv } from '../env.ts'
import { HttpError, readBody } from '../http.ts'
import { WORKSPACE_ID, workspaceStub } from '../workspace.ts'

export const ingest = new Hono<AppEnv>()

const TOKEN_PREFIX = 'chiul_'

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  const body = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${TOKEN_PREFIX}${body}`
}

/**
 * Minting or revoking a write credential needs the same full read access that publishing
 * does. A token can write into everyone's collections, so a persona that cannot read a
 * source must not be able to hand out a key that writes to it.
 */
function requireOperator(c: AppContext): void {
  const access = c.get('access')
  const everywhere =
    access.wildcard.detail === 'full' &&
    [...access.bySource.values()].every((v) => v.detail === 'full')
  if (!everywhere) {
    throw new HttpError(403, 'Minting a write token needs read access to every source.', {
      hint: 'Switch to a persona with full access. A write token can append to any collection this workspace publishes.',
      persona: access.persona.label,
    })
  }
}

function ingestOrigin(appUrl: string): string {
  const trimmed = appUrl.trim().replace(/\/+$/, '')
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`
}

// --- Machine surface ---

const IngestBody = z.object({
  /**
   * Portable Pi v3 entries, in file order. `sessionId` may be given once at the top level
   * or per entry; per entry wins, so one request can carry several sessions.
   */
  sessionId: z.string().optional(),
  /**
   * Which repo these sessions belong to — it decides the collection they publish into.
   * Defaults to the workspace's primary collection rather than being invented, because a
   * session with no repo cannot be published at all.
   */
  repo: z.string().min(1).max(200).optional(),
  entries: z
    .array(
      z.object({
        sessionId: z.string().optional(),
        seq: z.number().int().nonnegative().optional(),
        entry: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(5_000),
})

ingest.post('/', async (c) => {
  const header = c.req.header('authorization') ?? ''
  if (!header.startsWith('Bearer ')) {
    throw new HttpError(401, 'A write token is required', {
      hint: 'Send Authorization: Bearer <token>. Tokens are minted on the Overview page.',
    })
  }

  const d = db(c)
  const hash = await sha256Hex(header.slice(7).trim())
  const [token] = await d
    .select()
    .from(schema.ingestTokens)
    .where(and(eq(schema.ingestTokens.tokenHash, hash), isNull(schema.ingestTokens.revokedAt)))
    .limit(1)

  // Same response for "no such token" and "revoked token": a writer learns whether its
  // credential works, not whether it ever existed.
  if (!token) throw new HttpError(401, 'Invalid or revoked write token')

  const body = await readBody(c, IngestBody)

  const items = body.entries.map((item, i) => {
    const sessionId = item.sessionId ?? body.sessionId
    if (!sessionId) {
      throw new HttpError(422, 'Every entry needs a sessionId, or set one for the batch', {
        index: i,
      })
    }
    if (typeof item.entry['type'] !== 'string') {
      throw new HttpError(422, 'Each entry must be a Pi v3 record with a string `type`', {
        index: i,
      })
    }
    return { sessionId, seq: item.seq ?? i, entry: item.entry as Record<string, unknown> }
  })

  const result = await workspaceStub(c).accept(
    items,
    token.id,
    body.repo ?? c.env.UNDERLAY_DEFAULT_REPO,
  )

  await d
    .update(schema.ingestTokens)
    .set({ lastUsedAt: new Date(), writes: token.writes + result.accepted })
    .where(eq(schema.ingestTokens.id, token.id))

  return c.json({
    ok: true,
    ...result,
    // The writer is told when this will reach Underlay, so "did it persist" has an answer
    // that is not "eventually".
    flushIntervalMinutes: c.get('workspace').flushIntervalMinutes,
    autoFlush: c.get('workspace').autoFlush,
  })
})

// --- Operator surface ---

ingest.get('/status', async (c) => {
  const workspace = c.get('workspace')
  const d = db(c)

  const tokens = await d
    .select()
    .from(schema.ingestTokens)
    .where(eq(schema.ingestTokens.workspaceId, WORKSPACE_ID))
    .orderBy(desc(schema.ingestTokens.createdAt))

  const buffer = await workspaceStub(c).pendingSummary()
  const access = c.get('access')

  return c.json({
    // Normalised: `APP_URL` is hand-set per environment and a value without a scheme produced a
    // curl example that does not run. Assume https for a bare host rather than showing it broken.
    endpoint: `${ingestOrigin(c.env.APP_URL)}/api/ingest`,
    flushIntervalMinutes: workspace.flushIntervalMinutes,
    autoFlush: workspace.autoFlush,
    lastFlushAt: workspace.lastFlushAt,
    buffer,
    tokens: tokens.map((t) => ({
      id: t.id,
      label: t.label,
      prefix: t.prefix,
      writes: t.writes,
      createdAt: t.createdAt,
      lastUsedAt: t.lastUsedAt,
      revoked: t.revokedAt !== null,
    })),
    canManage: (() => {
      try {
        requireOperator(c)
        return true
      } catch {
        return false
      }
    })(),
    persona: access.persona.label,
  })
})

ingest.post('/tokens', async (c) => {
  requireOperator(c)
  const { label } = await readBody(c, z.object({ label: z.string().min(1).max(60) }))

  const token = newToken()
  const now = new Date()
  const id = `tok_${crypto.randomUUID()}`
  await db(c)
    .insert(schema.ingestTokens)
    .values({
      id,
      workspaceId: WORKSPACE_ID,
      label,
      tokenHash: await sha256Hex(token),
      // Enough to recognise the row later, not enough to reconstruct the token.
      prefix: token.slice(0, TOKEN_PREFIX.length + 6),
      createdAt: now,
    })

  // The only time the token is ever returned. It is stored hashed, so this cannot be
  // repeated — which is the property that makes the hash worth having. The id comes back too so
  // a caller can revoke exactly what it created.
  return c.json({ id, token, label, shownOnce: true }, 201)
})

ingest.post('/tokens/:id/revoke', async (c) => {
  requireOperator(c)
  await db(c)
    .update(schema.ingestTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(schema.ingestTokens.id, c.req.param('id')),
        eq(schema.ingestTokens.workspaceId, WORKSPACE_ID),
      ),
    )
  return c.json({ ok: true })
})

/**
 * Drop everything buffered without publishing it.
 *
 * Exists because the buffer is the one place in this system holding data that has not been
 * committed anywhere — and test writes accumulate there. Without a discard, running the smoke
 * suite twice and then pressing Push would publish `smoke-*` sessions into a real collection.
 */
ingest.post('/discard', async (c) => {
  requireOperator(c)
  const discarded = await workspaceStub(c).discardPending()
  return c.json({ ok: true, discarded })
})

ingest.post('/policy', async (c) => {
  requireOperator(c)
  const { flushIntervalMinutes, autoFlush } = await readBody(
    c,
    z.object({
      flushIntervalMinutes: z.number().int().min(1).max(1440).optional(),
      autoFlush: z.boolean().optional(),
    }),
  )

  const set: Record<string, unknown> = { updatedAt: new Date() }
  if (flushIntervalMinutes !== undefined) set['flushIntervalMinutes'] = flushIntervalMinutes
  if (autoFlush !== undefined) set['autoFlush'] = autoFlush

  await db(c).update(schema.workspaces).set(set).where(eq(schema.workspaces.id, WORKSPACE_ID))
  return c.json({ ok: true })
})

/**
 * Commit the buffer now.
 *
 * Flush and re-publish are the same operation: buffered entries join the main tables, then
 * the layout is published. Content addressing means only genuinely new records upload, so
 * flushing a handful of turns costs a manifest and those turns — not the corpus.
 */
ingest.post('/flush', async (c) => {
  requireOperator(c)
  const workspace = c.get('workspace')

  if (!c.env.UNDERLAY_API_KEY) {
    throw new HttpError(400, 'No Underlay API key is configured, so nothing can be committed.')
  }

  const results = await workspaceStub(c).publish({
    underlayUrl: workspace.underlayUrl,
    apiKey: c.env.UNDERLAY_API_KEY,
    orgSlug: workspace.orgSlug,
    layout: 'repo',
    prefix: 'chi',
    schemas: CHIUL_SCHEMAS,
  })

  const now = new Date()
  const d = db(c)
  await d
    .update(schema.workspaces)
    .set({ lastFlushAt: now, updatedAt: now })
    .where(eq(schema.workspaces.id, WORKSPACE_ID))

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
  }

  return c.json({
    ok: true,
    results,
    uploaded: results.reduce((n, r) => n + r.uploaded, 0),
  })
})
