/**
 * Portable Pi v3 session JSONL.
 *
 * These types describe only the fields chiul reads. They are deliberately open
 * (`[key: string]: unknown`) because the whole point is that an entry passes
 * through untouched: we project *over* entries, never *into* them. If a new
 * record type or content part appears, it must survive the round trip without
 * this file knowing it exists.
 *
 * Field names follow the corpus, verified against all 65 files:
 *   type ∈ message | custom | thinking_level_change | session_info | model_change
 *        | session | title_change | title | compaction | custom_message
 *        | service_tier_change | ttsr_injection
 */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** Every entry carries `type`. `id`/`timestamp`/`parentId` are *usually* present. */
export type ChiEntry = {
  type: string
  /** Absent on 18 of 9,299 corpus records (`title` and some `custom_message`). */
  id?: string
  parentId?: string | null
  timestamp?: string
  [key: string]: unknown
}

export type ChiUsage = {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cacheWrite1h?: number
  reasoning?: number
  reasoningTokens?: number
  totalTokens?: number
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number }
}

export type ChiContentPart = {
  type: string
  text?: string
  thinking?: string
  toolName?: string
  name?: string
  arguments?: unknown
  [key: string]: unknown
}

export type ChiMessage = {
  role?: string
  content?: string | ChiContentPart[]
  model?: string
  provider?: string
  api?: string
  toolName?: string
  usage?: ChiUsage
  [key: string]: unknown
}

/** A parsed session file: entries in file order, plus the bytes we must reproduce. */
export type ParsedSession = {
  sessionId: string
  /** Entries in original line order. */
  entries: ChiEntry[]
  /** True when the source file ended with a newline (all 65 in the corpus do). */
  trailingNewline: boolean
}
