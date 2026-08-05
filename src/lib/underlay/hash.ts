/**
 * Record hashing — must agree byte-for-byte with Underlay's implementation
 * (`underlay_v3/src/lib/core/hash.ts`), or every record looks "changed" on
 * commit and a 50-row edit re-uploads the whole collection.
 *
 * Two things are load-bearing and easy to break:
 *   1. `canonicalize` sorts object keys recursively, but ONLY inside `data`.
 *   2. The outer envelope key order is `id, type, data` — insertion order, not
 *      sorted. JSON.stringify preserves it, so don't "tidy" this.
 *
 * Underlay uses node:crypto; we use Web Crypto, which is async. Same digest.
 */

export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(canonicalize)
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = canonicalize((value as Record<string, unknown>)[key])
  }
  return sorted
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return toHex(digest)
}

/** The exact string Underlay hashes. Stored per row as `_record`. */
export function canonicalRecord(record: { id: string; type: string; data: unknown }): string {
  return JSON.stringify({
    id: record.id,
    type: record.type,
    data: canonicalize(record.data),
  })
}

export async function hashRecord(record: {
  id: string
  type: string
  data: unknown
}): Promise<{ hash: string; canonical: string }> {
  const canonical = canonicalRecord(record)
  return { hash: await sha256Hex(canonical), canonical }
}

/** Re-hash an already-canonical string without re-serializing it. */
export async function hashCanonical(canonical: string): Promise<string> {
  return sha256Hex(canonical)
}

export async function hashSchema(schemaBody: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(canonicalize(schemaBody)))
}
