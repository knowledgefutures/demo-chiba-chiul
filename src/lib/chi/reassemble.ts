/**
 * Records → JSONL. The other half of the round-trip gate.
 *
 * Deliberately reads only what a *reader* of the collection could read: Entry
 * records and the Session record. Nothing is carried over from the ingest side in
 * memory, or the test would be checking our own variables rather than what
 * Underlay actually stored.
 */
import { decodeUnstorable } from './unstorable.ts'
import { serializeSession } from './parse.ts'
import type { UnderlayRecord } from './project.ts'
import type { ChiEntry } from './types.ts'

export function reassembleSession(records: readonly UnderlayRecord[], sessionId: string): string {
  const entries: { seq: number; entry: ChiEntry }[] = []
  let trailingNewline = true
  let sawSession = false

  for (const record of records) {
    if (record.type === 'Session' && record.data['sessionId'] === sessionId) {
      sawSession = true
      // Absent for a caller without the key only if we ever mark it private;
      // it is not private, so treat absence as the default rather than an error.
      trailingNewline = record.data['trailingNewline'] !== false
      continue
    }
    if (record.type !== 'Entry' || record.data['sessionId'] !== sessionId) continue
    const seq = record.data['seq']
    const entry = record.data['entry']
    if (typeof seq !== 'number' || typeof entry !== 'object' || entry === null) {
      throw new Error(`record ${record.id}: Entry needs a numeric \`seq\` and an object \`entry\``)
    }
    // Reverse the encoding only where the record declares it. Decoding
    // unconditionally would be almost harmless but would silently rewrite a bare
    // sentinel character in a record that never went through the encoder.
    const decoded = record.data['pgEscaped'] === true ? decodeUnstorable(entry) : entry
    entries.push({ seq, entry: decoded as ChiEntry })
  }

  if (!sawSession) throw new Error(`no Session record for ${sessionId}`)
  if (entries.length === 0) throw new Error(`no Entry records for ${sessionId}`)

  entries.sort((a, b) => a.seq - b.seq)

  // A gap or duplicate means the collection is missing entries or holds two
  // records at one position; either way the file below would be silently wrong,
  // so fail loudly instead of emitting something plausible.
  for (const [i, e] of entries.entries()) {
    if (e.seq !== i) {
      throw new Error(
        `${sessionId}: expected seq ${i} at position ${i}, got ${e.seq} — ` +
          `${entries.length} entries, gap or duplicate in the sequence`,
      )
    }
  }

  return serializeSession({ entries: entries.map((e) => e.entry), trailingNewline })
}
