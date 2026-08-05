/**
 * Locating the corpus.
 *
 * The corpus is **not** in this repo and must never be committed to it: it is
 * shared under terms that forbid redistribution, and it is the only surviving
 * server-side copy of the pre-migration sessions. So it is referenced by path and
 * treated as read-only.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the corpus is expected if `CHI_CORPUS_DIR` is unset. A sibling directory rather than a
 * path into anyone's checkout — and gitignored, so putting it here cannot commit it.
 */
export const DEFAULT_CORPUS_DIR = './chi-eval-corpus'

export function corpusDir(): string | null {
  const dir = process.env['CHI_CORPUS_DIR'] ?? DEFAULT_CORPUS_DIR
  return existsSync(join(dir, 'index.json')) ? dir : null
}

export type CorpusIndex = {
  sessionCount: number
  approxTokensTotal: number
  sessions: {
    file: string
    sessionId: string
    startedAt: string
    lastAt: string
    cwd?: string
    messages: number
    approxTokens: number
  }[]
}

export function readIndex(dir: string): CorpusIndex {
  return JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as CorpusIndex
}

/** `owner/repo` → the session files under it. The corpus nests one repo deep. */
export function listSessionFiles(dir: string): { repo: string; path: string; file: string }[] {
  const out: { repo: string; path: string; file: string }[] = []
  for (const owner of readdirSync(dir, { withFileTypes: true })) {
    if (!owner.isDirectory()) continue
    for (const repo of readdirSync(join(dir, owner.name), { withFileTypes: true })) {
      if (!repo.isDirectory()) continue
      const repoDir = join(dir, owner.name, repo.name)
      for (const file of readdirSync(repoDir)) {
        if (!file.endsWith('.jsonl')) continue
        out.push({ repo: `${owner.name}/${repo.name}`, path: join(repoDir, file), file })
      }
    }
  }
  out.sort((a, b) => a.file.localeCompare(b.file))
  return out
}
