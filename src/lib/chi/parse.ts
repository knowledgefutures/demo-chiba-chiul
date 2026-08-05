/**
 * JSONL ↔ entries. The only place that touches raw bytes.
 *
 * Verified across the whole corpus (9,299 records): `JSON.stringify(JSON.parse(line))`
 * is byte-identical to `line` for every record — no `\uXXXX` escapes, no float
 * reformatting, no key reordering. That is what makes `serializeSession` able to
 * reproduce a source file from parsed entries alone, and why chiul does not need
 * to store the raw line beside the parsed one.
 *
 * It is also a property of *this* corpus, not a law. `serializeSession` is exact
 * only up to that property, so `roundTripKind` reports which of the three
 * guarantees actually held rather than assuming the strongest one.
 */
import type { ChiEntry, ParsedSession } from './types.ts'

export function parseSession(text: string): ParsedSession {
  const trailingNewline = text.endsWith('\n')
  const entries: ChiEntry[] = []

  for (const [i, line] of text.split('\n').entries()) {
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      throw new Error(`line ${i + 1}: not valid JSON (${(err as Error).message})`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`line ${i + 1}: expected a JSON object, got ${typeof parsed}`)
    }
    const entry = parsed as ChiEntry
    if (typeof entry.type !== 'string') {
      throw new Error(`line ${i + 1}: entry has no string \`type\``)
    }
    entries.push(entry)
  }

  // The corpus README says "the first record is a `session` header". For 11 of the
  // 65 files it is not: they open with a `title` record carrying a `pad` field of
  // trailing spaces — a fixed-width slot so the title can be rewritten in place
  // without rewriting the file. Its title can even drift from the header's.
  //
  // So the header is *located*, not assumed. An importer built to the README would
  // reject a sixth of this corpus.
  const header = entries.find((e) => e.type === 'session')
  if (!header || typeof header.id !== 'string') {
    throw new Error('no `session` header with a string id found in this file')
  }

  return { sessionId: header.id, entries, trailingNewline }
}

/** Entries in file order → the JSONL text. Inverse of `parseSession`. */
export function serializeSession(session: Pick<ParsedSession, 'entries' | 'trailingNewline'>): string {
  const body = session.entries.map((e) => JSON.stringify(e)).join('\n')
  return session.trailingNewline ? `${body}\n` : body
}

/**
 * Which round-trip guarantee holds between two JSONL texts. See the plan's §0
 * A/B/C table — the point is to report the strongest one that *actually* holds,
 * never to assume it.
 *
 *   raw       — identical bytes.
 *   canonical — identical after recursive key sorting. Catches float drift,
 *               unicode mangling, null coercion, silent truncation.
 *   semantic  — deep-equal values. This is the load-bearing claim: nothing lost.
 *   differs   — something was actually lost or changed.
 */
export type RoundTripKind = 'raw' | 'canonical' | 'semantic' | 'differs'

export function roundTripKind(before: string, after: string): RoundTripKind {
  if (before === after) return 'raw'

  const a = before.split('\n').filter((l) => l.length > 0)
  const b = after.split('\n').filter((l) => l.length > 0)
  if (a.length !== b.length) return 'differs'

  let canonical = true
  for (const [i, lineA] of a.entries()) {
    const lineB = b[i]!
    const ca = JSON.stringify(sortKeys(JSON.parse(lineA)))
    const cb = JSON.stringify(sortKeys(JSON.parse(lineB)))
    if (ca !== cb) {
      canonical = false
      if (!deepEqual(JSON.parse(lineA), JSON.parse(lineB))) return 'differs'
    }
  }
  return canonical ? 'canonical' : 'semantic'
}

export function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(sortKeys)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    out[key] = sortKeys((value as Record<string, unknown>)[key])
  }
  return out
}

/**
 * Value equality, distinct from canonical equality: `1.0` and `1` are equal here
 * and also canonically equal, but `{"a":1,"b":2}` vs `{"b":2,"a":1}` is canonically
 * equal while a naive string compare is not. Both matter, for different reasons.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }
  if (typeof a !== 'object') return false
  const ka = Object.keys(a as Record<string, unknown>)
  const kb = Object.keys(b as Record<string, unknown>)
  if (ka.length !== kb.length) return false
  return ka.every(
    (k) =>
      k in (b as Record<string, unknown>) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  )
}
