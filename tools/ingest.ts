/**
 * Corpus → Underlay collections.
 *
 *   node tools/ingest.ts --owner <org-slug> [--grouping person|repo] [--dry-run]
 *
 * Env: UNDERLAY_URL (default http://localhost:4100), UNDERLAY_API_KEY, CHI_CORPUS_DIR.
 *
 * Every collection is created **private**. That is not a default to flip: privacy in
 * Underlay is evaluated per collection over globally shared records, so one public
 * layout would expose every record in every other layout too.
 *
 * Run it twice with two groupings to see the point: the second layout reports
 * `uploaded 0` because the records already exist by hash, and only a manifest is
 * written.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { corpusDir, listSessionFiles } from '../src/lib/chi/corpus.ts'
import { parseSession } from '../src/lib/chi/parse.ts'
import { buildSourceMap, projectSession, sessionCwd, UNATTRIBUTED } from '../src/lib/chi/project.ts'
import type { UnderlayRecord } from '../src/lib/chi/project.ts'
import { UnderlayClient, UnderlayError } from '../src/lib/underlay/client.ts'
import { CHIUL_SCHEMAS } from '../src/lib/underlay/schema.ts'

const { values } = parseArgs({
  options: {
    owner: { type: 'string' },
    grouping: { type: 'string', default: 'person' },
    'dry-run': { type: 'boolean', default: false },
    prefix: { type: 'string', default: 'chi' },
  },
})

const grouping = values.grouping
if (grouping !== 'person' && grouping !== 'repo') {
  console.error(`--grouping must be "person" or "repo", got "${grouping}"`)
  process.exit(1)
}
if (!values['dry-run'] && !values.owner) {
  console.error('--owner <org-slug> is required (or pass --dry-run)')
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
  session: parseSession(readFileSync(path, 'utf8')),
}))
const sourceMap = buildSourceMap(parsed.map(({ session }) => sessionCwd(session.entries)))

console.log(`corpus: ${parsed.length} sessions from ${dir}`)
console.log(`sources: ${[...sourceMap.values()].join(', ')} (+ ${UNATTRIBUTED})`)

/** Grouping key → slug fragment. `person` groups by source label, `repo` by repo. */
function groupKey(entry: (typeof parsed)[number]): string {
  if (grouping === 'repo') return entry.repo.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const cwd = sessionCwd(entry.session.entries)
  const label = cwd ? (sourceMap.get(cwd) ?? UNATTRIBUTED) : UNATTRIBUTED
  return label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
}

const groups = new Map<string, UnderlayRecord[]>()
const sessionCounts = new Map<string, number>()
for (const entry of parsed) {
  const key = groupKey(entry)
  const records = projectSession(entry.session, { repo: entry.repo, sourceMap })
  groups.set(key, [...(groups.get(key) ?? []), ...records])
  sessionCounts.set(key, (sessionCounts.get(key) ?? 0) + 1)
}

console.log(`\ngrouping "${grouping}" → ${groups.size} collections:`)
for (const [key, records] of [...groups].sort()) {
  console.log(
    `  ${values.prefix}-${key}: ${sessionCounts.get(key)} sessions, ${records.length} records`,
  )
}

if (values['dry-run']) {
  const total = [...groups.values()].reduce((n, r) => n + r.length, 0)
  console.log(`\ndry run — ${total} records total, nothing pushed`)
  process.exit(0)
}

const client = new UnderlayClient({
  baseUrl: process.env['UNDERLAY_URL'] ?? 'http://localhost:4100',
  apiKey: process.env['UNDERLAY_API_KEY'],
})
const owner = values.owner!

let totalUploaded = 0
let totalRecords = 0

for (const [key, records] of [...groups].sort()) {
  const slug = `${values.prefix}-${key}`
  process.stdout.write(`\n${owner}/${slug}: `)

  try {
    const collection = await client.createCollection(owner, slug, {
      name: `Chi sessions — ${key}`,
      public: false,
    })
    process.stdout.write(collection.existed ? 'exists' : `created${collection.ark ? ` (${collection.ark})` : ''}`)

    const latest = await client.latestVersion(owner, slug)
    const result = await client.push(owner, slug, records, {
      schemas: CHIUL_SCHEMAS,
      message: `chi corpus ingest — grouping=${grouping}`,
      baseVersion: latest?.semver ?? null,
      appId: 'chiul',
    })

    totalUploaded += result.uploaded
    totalRecords += result.recordCount
    console.log(
      `\n  → ${result.semver}: ${result.recordCount} records in manifest, ${result.uploaded} uploaded` +
        (result.uploaded === 0 ? '  ← already stored by hash; only a manifest was written' : ''),
    )
  } catch (err) {
    if (err instanceof UnderlayError) {
      console.error(`\n  ✗ ${err.message}`)
      process.exitCode = 1
    } else {
      throw err
    }
  }
}

console.log(`\n${totalRecords} records across ${groups.size} collections; ${totalUploaded} uploaded`)
