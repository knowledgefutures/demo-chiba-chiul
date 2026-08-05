/**
 * Entries → the four record types.
 *
 * The type boundary is Chi's own validity boundary (chi-commons `DESIGN.md` § 0):
 *
 *   Entry, Reduction  — the endomorphism side. `Entry.entry` is valid Pi v3, and
 *                       stays valid at every z, because reduce-to-artifact is an
 *                       endomorphism on v3.
 *   Session, Metrics  — the projection side. Explicitly *not* v3. Derived, and
 *                       rebuildable from Entry at any time.
 *
 * Splitting by z instead would break both content-address dedup across ingests
 * and schema-hash alignment across collections. See the plan, §1.
 */
import { encodeUnstorable, hasUnstorable } from './unstorable.ts'
import type { ChiEntry, ChiMessage, ChiUsage, ParsedSession } from './types.ts'

export type UnderlayRecord = { id: string; type: string; data: Record<string, unknown> }

/**
 * A source is a *machine*, not a person. Three distinct `cwd` roots appear in the
 * corpus and 29 of 65 sessions have no `cwd` at all, so "who" is not knowable from
 * the data. `/home/exedev/chi` is a shared dev.exe environment either participant
 * could have been using.
 *
 * Hence neutral labels until we get the real mapping from the Chi team. Guessing
 * would put a name on the wrong person's transcript.
 */
export const UNATTRIBUTED = 'Unattributed'

export function buildSourceMap(cwds: readonly (string | null | undefined)[]): Map<string, string> {
  const roots = [...new Set(cwds.filter((c): c is string => typeof c === 'string' && c.length > 0))]
  roots.sort()
  return new Map(roots.map((root, i) => [root, `User ${i + 1}`]))
}

export function sessionCwd(entries: readonly ChiEntry[]): string | null {
  const header = entries.find((e) => e.type === 'session')
  const cwd = header?.['cwd']
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : null
}

/**
 * Title, preferring the most recent explicit naming. `session_info.name` and
 * `title_change.title` both occur, and a session may be renamed several times.
 */
export function sessionTitle(entries: readonly ChiEntry[]): string | null {
  let title: string | null = null
  for (const e of entries) {
    if (e.type === 'session_info' && typeof e['name'] === 'string') title = e['name']
    else if (e.type === 'title_change' && typeof e['title'] === 'string') title = e['title']
    else if (e.type === 'title' && typeof e['title'] === 'string') title = e['title']
  }
  return title
}

function asMessage(entry: ChiEntry): ChiMessage | null {
  const m = entry['message']
  return typeof m === 'object' && m !== null && !Array.isArray(m) ? (m as ChiMessage) : null
}

/**
 * Model-visible characters: text, thinking, and serialized tool-call arguments.
 *
 * Matches what chi-commons `DESIGN.md` says the z-menu estimate counts, so the
 * number chiul shows is comparable with the number Pi shows. System prompt and
 * tool schemas are excluded — they belong to the resuming runtime, not the source.
 */
export function modelVisibleChars(entries: readonly ChiEntry[]): number {
  let chars = 0
  for (const entry of entries) {
    const message = asMessage(entry)
    if (!message) continue
    const content = message.content
    if (typeof content === 'string') {
      chars += content.length
      continue
    }
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (typeof part.text === 'string') chars += part.text.length
      if (typeof part.thinking === 'string') chars += part.thinking.length
      if (part.arguments !== undefined) chars += JSON.stringify(part.arguments).length
    }
  }
  return chars
}

export const CHARS_PER_TOKEN = 4

export type SessionMetrics = {
  costUsd: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }
  toolCalls: Record<string, number>
  entryTypes: Record<string, number>
  roles: Record<string, number>
  models: string[]
  images: number
}

export function computeMetrics(entries: readonly ChiEntry[]): SessionMetrics {
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  const toolCalls: Record<string, number> = {}
  const entryTypes: Record<string, number> = {}
  const roles: Record<string, number> = {}
  const models = new Set<string>()
  let costUsd = 0
  let images = 0

  for (const entry of entries) {
    entryTypes[entry.type] = (entryTypes[entry.type] ?? 0) + 1
    const message = asMessage(entry)
    if (!message) continue
    if (typeof message.role === 'string') roles[message.role] = (roles[message.role] ?? 0) + 1
    if (typeof message.model === 'string') models.add(message.model)

    const usage = message.usage as ChiUsage | undefined
    if (usage) {
      tokens.input += usage.input ?? 0
      tokens.output += usage.output ?? 0
      tokens.cacheRead += usage.cacheRead ?? 0
      tokens.cacheWrite += usage.cacheWrite ?? 0
      tokens.reasoning += usage.reasoning ?? usage.reasoningTokens ?? 0
      costUsd += usage.cost?.total ?? 0
    }

    const content = message.content
    if (!Array.isArray(content)) continue
    for (const part of content) {
      if (part.type === 'toolCall') {
        const name = part.toolName ?? part.name ?? 'unknown'
        toolCalls[name] = (toolCalls[name] ?? 0) + 1
      } else if (part.type === 'image') {
        images++
      }
    }
  }

  return { costUsd, tokens, toolCalls, entryTypes, roles, models: [...models].sort(), images }
}

/**
 * Leaves of the entry tree. The corpus is entirely linear — every one of the 65
 * sessions has exactly one leaf, which is worth knowing because Chi's own
 * three-machine validation expects branches and this snapshot has none.
 */
export function leafEntryIds(entries: readonly ChiEntry[]): string[] {
  const ids = new Set<string>()
  const parents = new Set<string>()
  for (const e of entries) {
    if (typeof e.id === 'string') ids.add(e.id)
    if (typeof e.parentId === 'string') parents.add(e.parentId)
  }
  return [...ids].filter((id) => !parents.has(id))
}

export type ProjectOptions = {
  /** `owner/slug` of the repo the sessions were recorded against. */
  repo: string | null
  /** cwd → neutral source label, from `buildSourceMap`. */
  sourceMap: Map<string, string>
}

/**
 * Entry record id is `sessionId:entryId`. Underlay record ids are not unique
 * within a collection (`ask` found 1,600 records under 1,595 ids and silently
 * collapsed five), and Chi entry ids are 8 hex chars unique only *within* a
 * session — so the session id has to be part of it.
 *
 * 18 corpus records carry no `id` at all. They fall back to the file position,
 * which `seq` records anyway.
 */
export function entryRecordId(sessionId: string, entry: ChiEntry, seq: number): string {
  return `${sessionId}:${typeof entry.id === 'string' ? entry.id : `#${seq}`}`
}

export function projectSession(session: ParsedSession, opts: ProjectOptions): UnderlayRecord[] {
  const { entries, sessionId } = session
  const cwd = sessionCwd(entries)
  const metrics = computeMetrics(entries)
  const timestamps = entries
    .map((e) => e['timestamp'])
    .filter((t): t is string => typeof t === 'string')
    .sort()

  const records: UnderlayRecord[] = entries.map((entry, seq) => {
    // Postgres jsonb cannot store U+0000 or a lone surrogate. Two corpus records
    // contain them, both from binary data landing in tool output. Encode reversibly
    // and say so on the record, rather than dropping it or failing the ingest.
    // See ./unstorable.ts.
    const needsEscape = hasUnstorable(entry)
    return {
      id: entryRecordId(sessionId, entry, seq),
      type: 'Entry',
      data: {
        sessionId,
        // File position. Needed to reproduce the source ordering exactly: the tree
        // in `parentId` constrains order but does not determine it, and 18 records
        // have no id to order by.
        seq,
        z: 0,
        reductionId: null,
        entry: (needsEscape ? encodeUnstorable(entry) : entry) as unknown as Record<
          string,
          unknown
        >,
        ...(needsEscape ? { pgEscaped: true } : {}),
      },
    }
  })

  records.push({
    id: sessionId,
    type: 'Session',
    data: {
      sessionId,
      title: sessionTitle(entries),
      startedAt: timestamps[0] ?? null,
      lastAt: timestamps[timestamps.length - 1] ?? null,
      source: cwd ? (opts.sourceMap.get(cwd) ?? UNATTRIBUTED) : UNATTRIBUTED,
      repo: opts.repo,
      // Machine-local and identifying, so it ships as a private field: present
      // for a caller holding the key, filtered server-side for everyone else.
      cwd,
      entryCount: entries.length,
      messageCount: metrics.entryTypes['message'] ?? 0,
      approxTokens: Math.round(modelVisibleChars(entries) / CHARS_PER_TOKEN),
      costUsd: metrics.costUsd,
      models: metrics.models,
      leafEntryIds: leafEntryIds(entries),
      trailingNewline: session.trailingNewline,
    },
  })

  records.push({
    id: `${sessionId}:metrics`,
    type: 'Metrics',
    data: { scope: 'session', scopeId: sessionId, ...metrics },
  })

  return records
}
