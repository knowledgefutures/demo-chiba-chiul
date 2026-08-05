/**
 * The Phase 0 gate, end to end.
 *
 *   node tools/roundtrip.ts --owner <org-slug> [--grouping person|repo]
 *
 * Reads every record back out of Underlay — through the ordinary paged read API,
 * not from anything held in memory here — reassembles each session's JSONL, and
 * reports which guarantee held, per the plan's §0 A/B/C table:
 *
 *   raw       every byte identical
 *   canonical identical after recursive key sorting  ← expected: jsonb normalizes order
 *   semantic  deep-equal values, some serialization difference beyond key order
 *   differs   something was actually lost            ← the only failure
 *
 * `differs` on even one session means the schema is wrong and Phases 1–2 move.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { corpusDir, listSessionFiles } from '../src/lib/chi/corpus.ts'
import { parseSession, roundTripKind } from '../src/lib/chi/parse.ts'
import type { RoundTripKind } from '../src/lib/chi/parse.ts'
import { buildSourceMap, sessionCwd, UNATTRIBUTED } from '../src/lib/chi/project.ts'
import { reassembleSession } from '../src/lib/chi/reassemble.ts'
import { UnderlayClient } from '../src/lib/underlay/client.ts'

const { values } = parseArgs({
  options: {
    owner: { type: 'string' },
    grouping: { type: 'string', default: 'person' },
    prefix: { type: 'string', default: 'chi' },
  },
})

if (!values.owner) {
  console.error('--owner <org-slug> is required')
  process.exit(1)
}

const dir = corpusDir()
if (!dir) {
  console.error('corpus not found — set CHI_CORPUS_DIR to the chi-eval-corpus path')
  process.exit(1)
}

const files = listSessionFiles(dir)
const parsed = files.map(({ path, file, repo }) => ({
  file,
  repo,
  text: readFileSync(path, 'utf8'),
}))
const sourceMap = buildSourceMap(
  parsed.map(({ text }) => sessionCwd(parseSession(text).entries)),
)

const client = new UnderlayClient({
  baseUrl: process.env['UNDERLAY_URL'] ?? 'http://localhost:4100',
  apiKey: process.env['UNDERLAY_API_KEY'],
})
const owner = values.owner

function slugFor(entry: (typeof parsed)[number]): string {
  const key =
    values.grouping === 'repo'
      ? entry.repo
      : (sessionCwd(parseSession(entry.text).entries)
          ? (sourceMap.get(sessionCwd(parseSession(entry.text).entries)!) ?? UNATTRIBUTED)
          : UNATTRIBUTED)
  return `${values.prefix}-${key.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`
}

// One paged read per collection, reused across its sessions.
const bySlug = new Map<string, (typeof parsed)[number][]>()
for (const entry of parsed) {
  const slug = slugFor(entry)
  bySlug.set(slug, [...(bySlug.get(slug) ?? []), entry])
}

const outcomes: Record<RoundTripKind, number> = { raw: 0, canonical: 0, semantic: 0, differs: 0 }
const failures: { file: string; reason: string }[] = []

for (const [slug, entries] of [...bySlug].sort()) {
  const latest = await client.latestVersion(owner, slug)
  if (!latest) {
    console.error(`${owner}/${slug}: no version — run tools/ingest.ts first`)
    process.exit(1)
  }

  process.stdout.write(`${owner}/${slug} @ ${latest.semver}: reading… `)
  const records = await client.readAllRecords(owner, slug, latest.semver)
  console.log(`${records.length} records`)

  for (const entry of entries) {
    const sessionId = parseSession(entry.text).sessionId
    try {
      const kind = roundTripKind(entry.text, reassembleSession(records, sessionId))
      outcomes[kind]++
      if (kind === 'differs') failures.push({ file: entry.file, reason: 'content differs' })
    } catch (err) {
      outcomes.differs++
      failures.push({ file: entry.file, reason: (err as Error).message })
    }
  }
}

console.log('\n── round-trip result ──')
console.log(`  raw (byte-identical)      ${outcomes.raw}`)
console.log(`  canonical (key order)     ${outcomes.canonical}`)
console.log(`  semantic (values only)    ${outcomes.semantic}`)
console.log(`  differs (LOST DATA)       ${outcomes.differs}`)

for (const f of failures) console.error(`  ✗ ${f.file}: ${f.reason}`)

const passed = outcomes.raw + outcomes.canonical + outcomes.semantic
console.log(
  `\n${passed}/${parsed.length} sessions round-tripped with nothing lost` +
    (outcomes.differs > 0 ? ` — ${outcomes.differs} FAILED` : ''),
)
process.exitCode = outcomes.differs > 0 ? 1 : 0
