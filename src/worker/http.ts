/**
 * One error type and one response shape for the whole API. Lifted from Hot, for the
 * same reason it exists there: handlers that build their own error bodies drift.
 */
import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z } from 'zod'

import type { AppEnv } from './env.ts'

export class HttpError extends Error {
  status: ContentfulStatusCode
  extra: Record<string, unknown>

  constructor(
    status: ContentfulStatusCode,
    message: string,
    extra: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.extra = extra
  }
}

export async function readBody<S extends z.ZodTypeAny>(
  c: Context<AppEnv>,
  schema: S,
): Promise<z.infer<S>> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})))
  if (!parsed.success) {
    throw new HttpError(422, 'Invalid body', { issues: parsed.error.issues })
  }
  return parsed.data as z.infer<S>
}

export function intParam(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw ?? fallback)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), 0), max)
}
