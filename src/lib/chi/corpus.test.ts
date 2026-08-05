/**
 * The Phase 0 gate, offline.
 *
 * These tests cover everything *except* the network hop, and they cover it over
 * the real 65-file corpus rather than a fixture. The server round trip
 * (`tools/roundtrip.ts`) then confirms end to end what these assert locally.
 *
 * The interesting one is "survives jsonb normalization". Underlay stores record
 * `data` in a Postgres `jsonb` column, which is a parsed representation: it
 * normalizes key order and discards whitespace. `sortKeys` simulates exactly that
 * loss, so we can prove which of the three guarantees survives storage without a
 * database in the loop.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

import { corpusDir, listSessionFiles, readIndex } from './corpus.ts'
import { NUL } from './unstorable.ts'
import { parseSession, roundTripKind, sortKeys } from './parse.ts'
import { buildSourceMap, computeMetrics, projectSession, sessionCwd } from './project.ts'
import { reassembleSession } from './reassemble.ts'
import type { UnderlayRecord } from './project.ts'

const dir = corpusDir()
const suite = dir ? describe : describe.skip

if (!dir) {
  console.warn(
    '[corpus.test] corpus not found — set CHI_CORPUS_DIR to the chi-eval-corpus path. Skipping.',
  )
}

/** Real U+0000 characters in the parsed values of a JSONL text. */
function countNuls(jsonl: string): number {
  let n = 0
  const walk = (v: unknown): void => {
    if (typeof v === 'string') n += [...v].filter((c) => c === NUL).length
    else if (Array.isArray(v)) v.forEach(walk)
    else if (typeof v === 'object' && v !== null) {
      for (const [k, x] of Object.entries(v)) {
        n += [...k].filter((c) => c === NUL).length
        walk(x)
      }
    }
  }
  for (const line of jsonl.split('\n')) if (line.length > 0) walk(JSON.parse(line))
  return n
}

/** True when any parsed string holds an unpaired surrogate — not representable as UTF-8. */
function hasLoneSurrogate(jsonl: string): boolean {
  let found = false
  const walk = (v: unknown): void => {
    if (found) return
    if (typeof v === 'string') {
      for (const ch of v) {
        if (ch.length === 1) {
          const c = ch.charCodeAt(0)
          if (c >= 0xd800 && c <= 0xdfff) found = true
        }
      }
    } else if (Array.isArray(v)) v.forEach(walk)
    else if (typeof v === 'object' && v !== null) Object.values(v).forEach(walk)
  }
  for (const line of jsonl.split('\n')) if (line.length > 0) walk(JSON.parse(line))
  return found
}

/** What the store does to `data` on the way in: parse, normalize, forget ordering. */
function throughJsonb(records: readonly UnderlayRecord[]): UnderlayRecord[] {
  return records.map((r) => ({
    id: r.id,
    type: r.type,
    data: sortKeys(JSON.parse(JSON.stringify(r.data))) as Record<string, unknown>,
  }))
}

/**
 * Vitest evaluates the body of a `describe.skip` — it collects the tests, then marks them skipped.
 * So these fixtures must not throw when the corpus is absent, or a clone with no `CHI_CORPUS_DIR`
 * fails the suite instead of skipping it. The empty stand-in is never asserted against, because
 * every test that reads it is skipped in exactly that case.
 */
function loadFixtures(d: string) {
  const files = listSessionFiles(d)
  return {
    files,
    index: readIndex(d),
    sourceMap: buildSourceMap(
      files.map(({ path }) => sessionCwd(parseSession(readFileSync(path, 'utf8')).entries)),
    ),
  }
}

const fixtures: ReturnType<typeof loadFixtures> = dir
  ? loadFixtures(dir)
  : {
      files: [],
      index: { sessionCount: 0, approxTokensTotal: 0, sessions: [] },
      sourceMap: buildSourceMap([]),
    }

suite('chi corpus', () => {
  const { files, index, sourceMap } = fixtures

  it('finds every session the index declares', () => {
    expect(files.length).toBe(index.sessionCount)
  })

  it('parses every file, and each header id matches its filename', () => {
    for (const { path, file } of files) {
      const session = parseSession(readFileSync(path, 'utf8'))
      expect(session.sessionId, file).toBe(file.replace(/\.jsonl$/, ''))
      expect(session.entries.length).toBeGreaterThan(0)
    }
  })

  it('projects and reassembles byte-identically before storage', () => {
    for (const { path, file, repo } of files) {
      const text = readFileSync(path, 'utf8')
      const session = parseSession(text)
      const records = projectSession(session, { repo, sourceMap })
      expect(reassembleSession(records, session.sessionId), file).toBe(text)
    }
  })

  it('survives jsonb normalization with values intact (guarantee A and B, not C)', () => {
    const kinds = new Set<string>()
    for (const { path, file, repo } of files) {
      const text = readFileSync(path, 'utf8')
      const session = parseSession(text)
      const stored = throughJsonb(projectSession(session, { repo, sourceMap }))
      const kind = roundTripKind(text, reassembleSession(stored, session.sessionId))
      expect(kind, file).not.toBe('differs')
      kinds.add(kind)
    }
    // Recorded rather than asserted tightly: 'canonical' is the expected outcome
    // and 'raw' would be a bonus. Either is a pass; 'differs' above is the failure.
    expect([...kinds].every((k) => k === 'canonical' || k === 'raw')).toBe(true)
  })

  it('gives every entry a unique record id within its session', () => {
    for (const { path, file, repo } of files) {
      const session = parseSession(readFileSync(path, 'utf8'))
      const entryIds = projectSession(session, { repo, sourceMap })
        .filter((r) => r.type === 'Entry')
        .map((r) => r.id)
      expect(new Set(entryIds).size, file).toBe(entryIds.length)
    }
  })

  it('reproduces the corpus totals stated in its README', () => {
    let entries = 0
    let messages = 0
    let cost = 0
    for (const { path } of files) {
      const { entries: parsed } = parseSession(readFileSync(path, 'utf8'))
      const metrics = computeMetrics(parsed)
      entries += parsed.length
      messages += metrics.entryTypes['message'] ?? 0
      cost += metrics.costUsd
    }
    expect(entries).toBe(9_299)
    expect(messages).toBe(8_278)
    expect(cost).toBeCloseTo(368.85, 1)
  })

  it('labels sources neutrally, and never leaks a real path into a label', () => {
    const bySource = new Map<string, number>()
    for (const { path, repo } of files) {
      const session = parseSession(readFileSync(path, 'utf8'))
      const sessionRecord = projectSession(session, { repo, sourceMap }).find(
        (r) => r.type === 'Session',
      )!
      const source = sessionRecord.data['source'] as string
      bySource.set(source, (bySource.get(source) ?? 0) + 1)
    }
    // Three machine roots (10 / 20 / 6) plus 29 with no cwd in the header at all.
    expect([...bySource.keys()].sort()).toEqual(['Unattributed', 'User 1', 'User 2', 'User 3'])
    expect(bySource.get('Unattributed')).toBe(29)
    expect([...bySource.values()].reduce((a, b) => a + b)).toBe(65)
    // The forbidden strings are derived from the corpus rather than written here: the test
    // gets strictly stronger (it covers whatever roots the data actually contains) and this
    // file carries no real usernames or paths, which matters if the repo is ever public.
    const realSegments = [...sourceMap.keys()].flatMap((root) => root.split('/').filter(Boolean))
    for (const key of bySource.keys()) {
      for (const segment of realSegments) {
        expect(key.toLowerCase()).not.toContain(segment.toLowerCase())
      }
    }
  })

  /**
   * Reading the session header from line 1 is wrong, and their own index builder
   * does it: `index.json` carries `sessionId: null` and `cwd: null` for exactly the
   * 11 files that open with a padded `title` record. `startedAt`/`messages`/
   * `approxTokens` are right in those rows, because those scan every line — so the
   * defect is precisely "header assumed at [0]", a one-line fix upstream.
   *
   * This is pinned as a test because it is the reason chiul reads more attribution
   * out of the corpus than the index admits: the README calls those cwds
   * "anonymised", but 11 of them were never removed — the index just failed to read
   * them, and the paths are still in the session headers.
   */
  it('recovers attribution the index reports as absent', () => {
    const indexHasCwd = index.sessions.filter((s) => s.cwd).length
    const headerHasCwd = files.filter(
      ({ path }) => sessionCwd(parseSession(readFileSync(path, 'utf8')).entries) !== null,
    ).length

    expect(indexHasCwd).toBe(25)
    expect(headerHasCwd).toBe(36)

    const nullIdRows = index.sessions.filter((s) => s.sessionId === null)
    expect(nullIdRows.length).toBe(11)
    // Every one still carries a cwd in its header, and all 11 share the same one — the
    // machine is identified by that fact, not by naming it in this file.
    const recovered = new Set<string>()
    for (const row of nullIdRows) {
      const match = files.find((f) => f.file === row.file)!
      const cwd = sessionCwd(parseSession(readFileSync(match.path, 'utf8')).entries)
      expect(row.cwd, row.file).toBeNull()
      expect(cwd, row.file).not.toBeNull()
      recovered.add(cwd!)
    }
    expect(recovered.size).toBe(1)
  })

  /**
   * Exactly one record in the corpus carries U+0000 — a `web_fetch` toolResult that
   * fetched binary content and captured 7 NUL bytes. Postgres jsonb rejects that
   * character outright, which surfaced as an opaque HTTP 500 on the batch containing
   * it. Pinned here because it is a one-in-9,299 case that will not reappear in any
   * hand-made fixture, and because the encoding has to stay reversible.
   */
  it('escapes the one record Postgres cannot store, reversibly', () => {
    // Found by the property under test rather than by session id, so no id from a private
    // corpus is written down here.
    const target = files.find(({ path }) => countNuls(readFileSync(path, 'utf8')) > 0)!
    const text = readFileSync(target.path, 'utf8')
    const session = parseSession(text)
    const records = projectSession(session, { repo: target.repo, sourceMap })

    const escaped = records.filter((r) => r.data['pgEscaped'] === true)
    expect(escaped.length).toBe(1)
    // Nothing that reaches the wire may contain the character.
    for (const record of records) {
      expect(JSON.stringify(record).includes(NUL), record.id).toBe(false)
    }
    // Guarantee B, not C: `throughJsonb` sorts keys, so raw bytes cannot match.
    // Asserting `toBe` here fails on the ordering rather than the NULs, and prints
    // a diff of the whole transcript while doing it.
    const restored = reassembleSession(throughJsonb(records), session.sessionId)
    expect(roundTripKind(text, restored)).toBe('canonical')
    // And the NULs specifically came back: counted on *parsed values*, because in
    // the text a NUL is the six-character escape `\u0000` — and the source also
    // contains that same sequence as literal backslash-text in places, so counting
    // it in the raw bytes would be ambiguous (14 textual matches, 7 real NULs).
    expect(countNuls(text)).toBe(7)
    expect(countNuls(restored)).toBe(7)
  })

  /**
   * Two records in 9,299 carry something Postgres JSON cannot hold, in two different
   * sessions and for two different reasons — a NUL and a lone surrogate, both from
   * binary data landing in tool output. Both arrived as one indistinguishable HTTP
   * 500. Pinned so the count is a fact rather than a memory.
   */
  it('finds exactly two unstorable records across the whole corpus', () => {
    const escaped: string[] = []
    for (const { path, repo, file } of files) {
      const session = parseSession(readFileSync(path, 'utf8'))
      for (const record of projectSession(session, { repo, sourceMap })) {
        if (record.data['pgEscaped'] === true) escaped.push(file)
      }
    }
    expect(escaped.length).toBe(2)
    // Two distinct sessions, for two distinct reasons — a NUL in one, a lone surrogate in
    // the other. Asserted as a shape, not as two ids from a private corpus.
    expect(new Set(escaped).size).toBe(2)
  })

  /** The lone-surrogate record, whose encoded form must be UTF-8 representable. */
  it('makes the lone-surrogate record encodable as UTF-8', () => {
    const target = files.find(
      ({ path }) => hasLoneSurrogate(readFileSync(path, 'utf8')) && countNuls(readFileSync(path, 'utf8')) === 0,
    )!
    const text = readFileSync(target.path, 'utf8')
    const session = parseSession(text)
    const records = projectSession(session, { repo: target.repo, sourceMap })

    expect(records.filter((r) => r.data['pgEscaped'] === true).length).toBe(1)
    // A lone surrogate cannot survive a UTF-8 encode/decode; the escaped form must.
    const wire = JSON.stringify(records)
    expect(Buffer.from(wire, 'utf8').toString('utf8')).toBe(wire)
    expect(roundTripKind(text, reassembleSession(throughJsonb(records), session.sessionId))).toBe(
      'canonical',
    )
  })

  it('marks cwd private in the schema, so the identifying field is the filtered one', async () => {
    const { SESSION_SCHEMA } = await import('../underlay/schema.ts')
    expect(SESSION_SCHEMA.properties.cwd.private).toBe(true)
  })
})
