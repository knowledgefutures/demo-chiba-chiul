/**
 * The demo gate: one shared password, and a persona.
 *
 * This is deliberately **not** authentication. It is a curtain over a demo so a link
 * can be shared without the transcripts being world-readable, plus a way to look at
 * the same data as different people. Anyone with the password can select any persona.
 *
 * Two rules keep it from teaching the wrong lesson:
 *
 *   1. The persona is a *cookie value the server signs*, not a client-supplied header,
 *      so the client cannot claim a persona it was not given. (It can still ask for
 *      one — that is the point — but it goes through here.)
 *   2. Persona access is enforced by filtering in the routes, using the same `grants`
 *      query a real product would run. The UI never hides what the API would return.
 *
 * The page says all of this out loud, because a demo that looks like a security
 * boundary is worse than one that admits it is a curtain.
 */
import type { Context } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'

import type { AppEnv } from './env.ts'

const GATE_COOKIE = 'chiul_gate'
const PERSONA_COOKIE = 'chiul_persona'
const MAX_AGE = 60 * 60 * 24 * 7

const encoder = new TextEncoder()

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(value))
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** `value.signature`, so a cookie cannot be edited by whoever holds it. */
async function sign(secret: string, value: string): Promise<string> {
  return `${value}.${await hmac(secret, value)}`
}

async function verify(secret: string, signed: string | undefined): Promise<string | null> {
  if (!signed) return null
  const dot = signed.lastIndexOf('.')
  if (dot <= 0) return null
  const value = signed.slice(0, dot)
  const expected = await hmac(secret, value)
  return timingSafeEqual(signed.slice(dot + 1), expected) ? value : null
}

/**
 * Fails closed. An environment with no `DEMO_PASSWORD` is locked, not open — the same
 * principle as Ask's `ADMIN_ONLY`, and for the same reason: the failure mode of a
 * mis-set variable should be "nobody gets in", never "everybody does".
 */
export function gateConfigured(c: Context<AppEnv>): boolean {
  return typeof c.env.DEMO_PASSWORD === 'string' && c.env.DEMO_PASSWORD.length > 0
}

export async function isUnlocked(c: Context<AppEnv>): Promise<boolean> {
  if (!gateConfigured(c)) return false
  return (await verify(c.env.SESSION_SECRET, getCookie(c, GATE_COOKIE))) === 'unlocked'
}

export async function unlock(c: Context<AppEnv>, password: string): Promise<boolean> {
  if (!gateConfigured(c)) return false
  if (!timingSafeEqual(password, c.env.DEMO_PASSWORD)) return false
  setCookie(c, GATE_COOKIE, await sign(c.env.SESSION_SECRET, 'unlocked'), {
    path: '/',
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: MAX_AGE,
  })
  return true
}

export function lock(c: Context<AppEnv>): void {
  setCookie(c, GATE_COOKIE, '', { path: '/', maxAge: 0 })
  setCookie(c, PERSONA_COOKIE, '', { path: '/', maxAge: 0 })
}

/**
 * Bumping this invalidates every persona cookie already issued, so returning visitors land
 * on the default persona again instead of whichever one they last selected.
 *
 * Needed when the default changes: adding `Chi core` did nothing for anyone who had already
 * visited, because their signed cookie still named an older persona and was still valid.
 */
const PERSONA_COOKIE_VERSION = '2'

export async function currentPersonaId(c: Context<AppEnv>): Promise<string | null> {
  const value = await verify(c.env.SESSION_SECRET, getCookie(c, PERSONA_COOKIE))
  if (value === null) return null
  const sep = value.indexOf(':')
  // Unversioned or stale-version cookies are ignored rather than migrated — the fallback
  // is the default persona, which is exactly where we want them.
  if (sep <= 0 || value.slice(0, sep) !== PERSONA_COOKIE_VERSION) return null
  return value.slice(sep + 1)
}

export async function setPersona(c: Context<AppEnv>, personaId: string): Promise<void> {
  setCookie(c, PERSONA_COOKIE, await sign(c.env.SESSION_SECRET, `${PERSONA_COOKIE_VERSION}:${personaId}`), {
    path: '/',
    httpOnly: true,
    secure: new URL(c.req.url).protocol === 'https:',
    sameSite: 'Lax',
    maxAge: MAX_AGE,
  })
}
