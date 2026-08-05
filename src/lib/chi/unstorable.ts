/**
 * The characters Postgres JSON cannot store.
 *
 * Underlay keeps record `data` in a `jsonb` column, and `jsonb` accepts any valid
 * Unicode scalar value — but two things in Chi's logs are not that:
 *
 *   1. **U+0000.** Rejected outright (`unsupported Unicode escape sequence`).
 *      One corpus record: a `web_fetch` toolResult that fetched binary content and
 *      captured 7 NUL bytes.
 *   2. **Lone surrogates** (U+D800–U+DFFF unpaired). Valid in a JS string and
 *      representable in JSON text, but not a Unicode scalar value, so they cannot be
 *      encoded as UTF-8 and Postgres refuses them. One corpus record, in a different
 *      session, with 1 unpaired surrogate.
 *
 * Both are 1-in-9,299 cases, both come from binary data landing in tool output, and
 * both surfaced as a single opaque HTTP 500 from `POST .../negotiate/:id/records`
 * naming neither the record nor the reason. Finding them took a bisect. Underlay
 * should return a 4xx that names the offending record — that is a real upstream
 * improvement, and it is in the plan's handoff list.
 *
 * The transform is **declared, not silent**: `Entry.data.pgEscaped` is set to true and
 * every string in the entry is encoded as below. Reassembly reverses it only where the
 * flag is set. The round-trip test proves losslessness against the two real records,
 * which no hand-made fixture would have contained.
 *
 * Encoding, with S = U+E000 (Private Use Area):
 *
 *   S            → S S           (a source S survives — the corpus does contain PUA)
 *   U+0000       → S '0'
 *   lone U+XXXX  → S 'u' XXXX    (four lowercase hex digits)
 *
 * Decoding reads S then one character: S is a literal S, '0' is a NUL, 'u' means the
 * next four hex digits are a code unit. Unambiguous both ways.
 */

export const NUL = '\u0000'
export const SENTINEL = '\uE000'

/**
 * `[...s]` iterates code points: a valid surrogate pair yields one 2-unit string, an
 * unpaired surrogate yields a 1-unit string still in the surrogate range. So a
 * length-1 chunk in that range is exactly a lone surrogate.
 */
function isLoneSurrogate(ch: string): boolean {
  if (ch.length !== 1) return false
  const code = ch.charCodeAt(0)
  return code >= 0xd800 && code <= 0xdfff
}

function needsEscape(ch: string): boolean {
  return ch === NUL || ch === SENTINEL || isLoneSurrogate(ch)
}

export function stringHasUnstorable(s: string): boolean {
  for (const ch of s) if (ch === NUL || isLoneSurrogate(ch)) return true
  return false
}

export function hasUnstorable(value: unknown): boolean {
  if (typeof value === 'string') return stringHasUnstorable(value)
  if (Array.isArray(value)) return value.some(hasUnstorable)
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value as Record<string, unknown>).some(
      ([k, v]) => stringHasUnstorable(k) || hasUnstorable(v),
    )
  }
  return false
}

export function encodeString(s: string): string {
  let needed = false
  for (const ch of s) {
    if (needsEscape(ch)) {
      needed = true
      break
    }
  }
  if (!needed) return s

  let out = ''
  for (const ch of s) {
    if (ch === SENTINEL) out += SENTINEL + SENTINEL
    else if (ch === NUL) out += `${SENTINEL}0`
    else if (isLoneSurrogate(ch)) {
      out += `${SENTINEL}u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`
    } else out += ch
  }
  return out
}

export function decodeString(s: string): string {
  if (!s.includes(SENTINEL)) return s

  let out = ''
  const chars = [...s]
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== SENTINEL) {
      out += chars[i]
      continue
    }
    const next = chars[++i]
    if (next === SENTINEL) {
      out += SENTINEL
    } else if (next === '0') {
      out += NUL
    } else if (next === 'u') {
      const hex = chars.slice(i + 1, i + 5).join('')
      if (/^[0-9a-f]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16))
        i += 4
      } else {
        // Not something `encodeString` produced. Emit literally rather than guess.
        out += SENTINEL + next
      }
    } else {
      out += SENTINEL + (next ?? '')
    }
  }
  return out
}

function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as unknown as T
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[fn(k)] = mapStrings(v, fn)
    }
    return out as unknown as T
  }
  return value
}

/** Encode every string and key. Only call when `hasUnstorable` is true. */
export function encodeUnstorable<T>(value: T): T {
  return mapStrings(value, encodeString)
}

export function decodeUnstorable<T>(value: T): T {
  return mapStrings(value, decodeString)
}
