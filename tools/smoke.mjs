/**
 * Every route exists, answers JSON, and enforces the gate. Needs the server running.
 *
 *   node tools/smoke.mjs [--base http://localhost:4700]
 *
 * This exists because a refactor once silently deleted seven route registrations in Hot
 * and every other gate passed — tsc does not typecheck route strings and the Worker still
 * boots. It also asserts the access model per persona, because "the grants table is
 * right" and "the API applies it" are different claims and only the second one matters.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: { base: { type: 'string', default: 'http://localhost:4700' } },
})
const BASE = values.base.replace(/\/+$/, '')

const password = (() => {
  const raw = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8')
  const line = raw.split('\n').find((l) => l.startsWith('DEMO_PASSWORD='))
  if (!line) throw new Error('DEMO_PASSWORD not found in .dev.vars')
  return line.slice('DEMO_PASSWORD='.length).trim()
})()

let failures = 0
let checks = 0

function check(name, ok, detail = '') {
  checks++
  if (ok) {
    console.log(`  ok   ${name}`)
  } else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/**
 * Re-unlock before each phase rather than carrying one cookie through the whole run.
 *
 * `wrangler dev` reloads whenever the built assets change, and a long single-cookie run
 * produced different failures on each invocation — 401s appearing partway through a loop of
 * routes that had just passed. A smoke test that is order- and state-dependent reports on
 * itself rather than on the server, so each phase now starts from a fresh unlock.
 */
function jar() {
  const cookies = new Map()
  return {
    header: () =>
      [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    absorb: (res) => {
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';')
        const eq = pair.indexOf('=')
        if (eq > 0) cookies.set(pair.slice(0, eq), pair.slice(eq + 1))
      }
    },
  }
}

async function call(cookies, path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(cookies.header() ? { cookie: cookies.header() } : {}),
      ...(init.headers ?? {}),
    },
  })
  cookies.absorb(res)
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

console.log(`smoke: ${BASE}`)

/** Unlock a fresh jar. Cheap, and it makes each phase independent of the last. */
async function unlockedJar() {
  const c = jar()
  const res = await call(c, '/api/gate', { method: 'POST', body: JSON.stringify({ password }) })
  if (res.status !== 200) throw new Error(`could not unlock: ${res.status}`)
  return c
}

// --- Unauthenticated surface ---
console.log('\ngate')
const anon = jar()
const health = await call(anon, '/api/health')
check('GET /api/health is 200 and unauthenticated', health.status === 200 && health.body?.ok === true)

const gate = await call(anon, '/api/gate')
check('GET /api/gate reports configured', gate.status === 200 && gate.body?.configured === true)

for (const path of ['/api/me', '/api/sessions', '/api/stats', '/api/workspace']) {
  const res = await call(anon, path)
  check(`${path} is 401 while locked`, res.status === 401, `got ${res.status}`)
}

const wrong = await call(anon, '/api/gate', {
  method: 'POST',
  body: JSON.stringify({ password: 'definitely-not-it' }),
})
check('wrong password is 401', wrong.status === 401, `got ${wrong.status}`)

// --- Authenticated surface ---
console.log('\nroutes')
const cookies = jar()
const unlocked = await call(cookies, '/api/gate', {
  method: 'POST',
  body: JSON.stringify({ password }),
})
check('correct password unlocks', unlocked.status === 200 && unlocked.body?.unlocked === true)

const me = await call(cookies, '/api/me')
check('GET /api/me returns a persona roster', me.status === 200 && me.body?.personas?.length >= 4)
/**
 * The default persona must be able to *read*. A least-privileged default is right for a
 * product and wrong for a demo: opening as `Outsider` made every list empty and every
 * search return nothing — the access model working exactly as designed, and
 * indistinguishable from a broken app.
 */
check(
  'the default persona can read the corpus',
  me.body?.persona?.label === 'Chi core',
  `got ${me.body?.persona?.label}`,
)

let workspace = await call(cookies, '/api/workspace')
if (workspace.status === 200 && workspace.body?.sessions === 0) {
  // Self-hydrating: every access assertion below needs sessions to reason about, and a
  // fresh Durable Object starts empty. Better to fill it than to fail 20 checks.
  console.log('  ..   workspace empty — hydrating from Underlay first')
  await call(cookies, '/api/workspace/hydrate', { method: 'POST', body: '{}' })
  workspace = await call(cookies, '/api/workspace')
}
check(
  'GET /api/workspace is hydrated',
  workspace.status === 200 && workspace.body?.sessions > 0,
  `status=${workspace.body?.status} sessions=${workspace.body?.sessions}`,
)

for (const path of [
  '/api/sessions',
  '/api/stats',
  '/api/stats/search?q=underlay',
  '/api/corpus',
  '/api/team',
]) {
  const res = await call(await unlockedJar(), path)
  check(`GET ${path} is 200`, res.status === 200, `got ${res.status}`)
}

const corpusRes = await call(await unlockedJar(), '/api/corpus')
check(
  'GET /api/corpus returns every session as kind marks',
  corpusRes.body?.sessions?.length > 0 &&
    corpusRes.body.sessions.every((s) => typeof s.marks === 'string' && s.marks.length > 0),
)
check(
  'corpus marks account for every record',
  corpusRes.body.sessions.reduce((n, s) => n + s.marks.length, 0) === corpusRes.body.totalEntries,
)
// Kind codes are the wire format for the map; an unknown code would silently render grey.
check(
  'every mark is a known kind code',
  corpusRes.body.sessions.every((s) => /^[hmtke]+$/.test(s.marks)),
)

const searchRes = await call(await unlockedJar(), '/api/stats/search?q=federation')
check(
  'search returns hits and facets for a term known to match',
  searchRes.body?.results?.length > 0 && searchRes.body.facets.kinds.length > 0,
  `${searchRes.body?.results?.length} hits`,
)
check(
  'search snippets carry match markers for highlighting',
  searchRes.body.results.some((h) => h.snippet.includes('⟦')),
)

const notFound = await call(await unlockedJar(), '/api/nope')
check('unknown API path is a JSON 404', notFound.status === 404 && !!notFound.body?.error)

// --- Access model, per persona ---
console.log('\naccess')
const personas = new Map(me.body.personas.map((p) => [p.label, p.id]))

async function as(label) {
  const c = await unlockedJar()
  const res = await call(c, '/api/me/persona', {
    method: 'POST',
    body: JSON.stringify({ personaId: personas.get(label) }),
  })
  if (res.status !== 200) throw new Error(`could not become ${label}: ${res.status}`)
  return c
}

const asUser1 = await as('User 1')
const list1 = await call(asUser1, '/api/sessions')
const own = list1.body.sessions.filter((s) => s.source === 'User 1')
const others = list1.body.sessions.filter((s) => s.source !== 'User 1')
check('a member may open their own sessions', own.every((s) => s.canOpen) && own.length > 0)
check('a member may not open anyone else’s', others.every((s) => !s.canOpen) && others.length > 0)
check(
  'private cwd is sent only for the member’s own source',
  own.every((s) => s.cwd !== undefined || s.cwd === null) && others.every((s) => s.cwd === undefined),
)

const otherSession = others[0]
const denied = await call(asUser1, `/api/sessions/${otherSession.sessionId}`)
check('another source’s session detail is 403', denied.status === 403, `got ${denied.status}`)
const deniedEntries = await call(asUser1, `/api/sessions/${otherSession.sessionId}/entries?z=0`)
check('another source’s entries are 403', deniedEntries.status === 403)

const ownSession = own[0]
const allowed = await call(asUser1, `/api/sessions/${ownSession.sessionId}/entries?z=0&limit=5`)
check(
  'own entries are readable at z=0',
  allowed.status === 200 && allowed.body.entries.length > 0,
  `got ${allowed.status}`,
)

const asSteward = await as('Team steward')
const stewardList = await call(asSteward, '/api/sessions')
check(
  'a withheld source is absent from the steward’s list entirely',
  stewardList.body.sessions.every((s) => s.source !== 'User 2') && stewardList.body.visibility.withheld > 0,
  `withheld=${stewardList.body.visibility.withheld}`,
)
check(
  'the steward never receives a private cwd',
  stewardList.body.sessions.every((s) => s.cwd === undefined),
)
const stewardRaw = await call(asSteward, `/api/sessions/${ownSession.sessionId}/entries?z=0`)
check('the steward is refused raw records', stewardRaw.status === 403, `got ${stewardRaw.status}`)
const stewardStats = await call(asSteward, '/api/stats')
check(
  'withheld sources are named in stats, not silently dropped',
  stewardStats.body.withheldSources.includes('User 2'),
)

/**
 * Provisioning publishes every source's records, so a persona that cannot read a source
 * must not be able to copy it into a new collection. This is the authz hole that
 * `authz.mjs` exists to catch in Hot and Ask, in the one place chiul can have it.
 */
const stewardTeam = await call(asSteward, '/api/team')
check('a restricted persona cannot manage the org', stewardTeam.body.canManage === false)
const stewardProvision = await call(asSteward, '/api/team/provision', {
  method: 'POST',
  body: JSON.stringify({ layout: 'repo' }),
})
check(
  'a restricted persona is refused provisioning',
  stewardProvision.status === 403,
  `got ${stewardProvision.status}`,
)

const coreTeam = await call(await unlockedJar(), '/api/team')
check('a full-access persona may manage the org', coreTeam.body.canManage === true)

const asOutsider = await as('Outsider')
const outsiderList = await call(asOutsider, '/api/sessions')
check(
  'an outsider receives no titles and no openable rows',
  outsiderList.body.sessions.every((s) => s.title === null && !s.canOpen),
)
const outsiderSearch = await call(asOutsider, '/api/stats/search?q=federation')
check(
  'search returns nothing to a persona with no raw access',
  outsiderSearch.body.results.length === 0 && outsiderSearch.body.searchableSources.length === 0,
)

// --- The write side ---
console.log('\ningest')
const opJar = await unlockedJar()

// The machine endpoint must not accept the demo cookie: if it did, any page a viewer
// visited could write session logs on their behalf.
const cookieWrite = await call(opJar, '/api/ingest', {
  method: 'POST',
  body: JSON.stringify({ sessionId: 's', entries: [{ entry: { type: 'message' } }] }),
})
check(
  'the ingest endpoint refuses a session cookie',
  cookieWrite.status === 401,
  `got ${cookieWrite.status}`,
)

const badToken = await call(jar(), '/api/ingest', {
  method: 'POST',
  headers: { authorization: 'Bearer chiul_not_a_real_token' },
  body: JSON.stringify({ sessionId: 's', entries: [{ entry: { type: 'message' } }] }),
})
check('an unknown write token is refused', badToken.status === 401, `got ${badToken.status}`)

const status = await call(opJar, '/api/ingest/status')
check(
  'GET /api/ingest/status reports the endpoint and buffer',
  status.status === 200 && typeof status.body.endpoint === 'string' && status.body.buffer !== undefined,
)
check('a full-access persona may mint write tokens', status.body.canManage === true)

const stewardIngest = await call(asSteward, '/api/ingest/status')
check('a restricted persona may not mint write tokens', stewardIngest.body.canManage === false)
const stewardMint = await call(asSteward, '/api/ingest/tokens', {
  method: 'POST',
  body: JSON.stringify({ label: 'should-not-work' }),
})
check('minting is refused for a restricted persona', stewardMint.status === 403, `got ${stewardMint.status}`)
const stewardFlush = await call(asSteward, '/api/ingest/flush', { method: 'POST' })
check('flushing is refused for a restricted persona', stewardFlush.status === 403)

// A real token, a real write, and the idempotency guarantee the endpoint advertises.
const mint = await call(opJar, '/api/ingest/tokens', {
  method: 'POST',
  body: JSON.stringify({ label: `smoke-${Date.now().toString(36)}` }),
})
check('a token is returned exactly once, with a prefix', mint.status === 201 && mint.body.token?.startsWith('chiul_'))

const writeJar = jar()
const sessionId = `smoke-${Date.now().toString(36)}`
const payload = {
  sessionId,
  entries: [
    { entry: { type: 'session', version: 3, id: sessionId, timestamp: new Date(0).toISOString() } },
    { entry: { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'smoke' }] } } },
  ],
}
const write = await call(writeJar, '/api/ingest', {
  method: 'POST',
  headers: { authorization: `Bearer ${mint.body.token}` },
  body: JSON.stringify(payload),
})
check('a valid token may write entries', write.status === 200 && write.body.accepted === 2, `accepted=${write.body?.accepted}`)
check('the response tells the writer when it will reach Underlay', typeof write.body.flushIntervalMinutes === 'number')

const replay = await call(writeJar, '/api/ingest', {
  method: 'POST',
  headers: { authorization: `Bearer ${mint.body.token}` },
  body: JSON.stringify(payload),
})
check(
  'replaying a batch is idempotent',
  replay.body.accepted === 0 && replay.body.duplicates === 2,
  `accepted=${replay.body?.accepted} duplicates=${replay.body?.duplicates}`,
)

// Revoke the token this run created, not whichever was newest beforehand.
const revoke = await call(opJar, `/api/ingest/tokens/${mint.body.id}/revoke`, {
  method: 'POST',
})
check('a token can be revoked', revoke.status === 200)

/**
 * Clean up. The buffer is the one place holding uncommitted data, so leaving `smoke-*` sessions
 * in it means the next push publishes test records into a real collection.
 */
const discard = await call(opJar, '/api/ingest/discard', { method: 'POST' })
check('the buffer can be discarded, so test writes never publish', discard.status === 200)
const after = await call(opJar, '/api/ingest/status')
check('the buffer is empty after cleanup', after.body.buffer.pending === 0, `pending=${after.body?.buffer?.pending}`)

// Discarding must not leave phantom sessions behind: `accept()` writes a placeholder session row
// as soon as a repo is named, and those rows outlived their entries until discard cleaned them up.
const sessionsAfter = await call(await unlockedJar(), '/api/sessions')
check(
  'no phantom zero-record sessions survive a discard',
  sessionsAfter.body.sessions.every((s) => s.entryCount > 0),
  `${sessionsAfter.body.sessions.filter((s) => s.entryCount === 0).length} with zero records`,
)
check(
  'the token this run created is no longer active',
  (await call(opJar, '/api/ingest/status')).body.tokens.find((t) => t.id === mint.body.id)?.revoked === true,
)

console.log(`\n${checks - failures}/${checks} checks passed`)
process.exit(failures > 0 ? 1 : 0)
