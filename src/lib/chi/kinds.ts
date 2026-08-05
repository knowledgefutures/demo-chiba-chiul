/**
 * One visual language for a session entry, used at every scale.
 *
 * The corpus map, the session strip and the transcript all colour by the same five
 * kinds, so zooming from 9,299 marks down to one message feels continuous: the same
 * colour means the same thing whether it is a 2px tick or a message bubble.
 *
 * Only **three hues** carry identity — blue (human), violet (model), aqua (tool) —
 * plus a recessive neutral for session events. That is deliberate: in a dense strip
 * any two marks can end up adjacent, which is the validator's `--pairs all` case, and
 * three is the most that clears CVD separation there. `thinking` shares the model hue
 * and separates by weight rather than by a fourth colour.
 *
 * Validated (light surface #fcfcfb, all pairs): worst CVD ΔE 13.0, worst
 * normal-vision ΔE 16.3. Aqua sits below 3:1 contrast, so it always ships beside a
 * visible label — the legend and the transcript's own row labels.
 */

export const KINDS = ['human', 'model', 'thinking', 'tool', 'event'] as const
export type Kind = (typeof KINDS)[number]

/** Single-character wire codes. The whole corpus's shape fits in ~9 KB of these. */
export const KIND_CODE: Record<Kind, string> = {
  human: 'h',
  model: 'm',
  thinking: 't',
  tool: 'k',
  event: 'e',
}

export const CODE_KIND: Record<string, Kind> = {
  h: 'human',
  m: 'model',
  t: 'thinking',
  k: 'tool',
  e: 'event',
}

/**
 * Classify one v3 entry by **who is speaking**.
 *
 * An earlier version classified any assistant turn containing a `toolCall` as `tool`,
 * which was a mistake worth recording: 7,678 of 9,299 entries came out `tool`, the corpus
 * map rendered as a wall of one colour, and `thinking` collapsed to a single entry because
 * an assistant turn nearly always carries thinking *and* a call together.
 *
 * The axis that actually reads is who produced the entry — human, model, tool, or the
 * runtime talking about itself. An assistant turn is the *model* speaking even when what
 * it says is "run this"; the tool gets its own colour when it answers. Weight then carries
 * whether the model reasoned on that turn, which keeps the identity palette at three hues.
 */
export function classifyEntry(entry: Record<string, unknown>): Kind {
  const type = entry['type']
  if (type !== 'message') return 'event'

  const message = entry['message'] as Record<string, unknown> | undefined
  const role = message?.['role']

  if (role === 'user' || role === 'fileMention' || role === 'bashExecution') return 'human'
  if (role === 'toolResult') return 'tool'

  if (role === 'assistant') {
    const content = message?.['content']
    if (!Array.isArray(content)) return 'model'
    const reasoned = (content as Record<string, unknown>[]).some(
      (part) => part['type'] === 'thinking',
    )
    return reasoned ? 'thinking' : 'model'
  }

  return 'event'
}

/**
 * A short human label for an entry, for row labels and tooltips.
 *
 * Session events get named specifically rather than lumped as "event", because
 * "thinking level → minimal" and "compaction" are exactly the things worth noticing
 * in a transcript and the reason events are rendered at all.
 */
export function describeEntry(entry: Record<string, unknown>): string {
  const type = String(entry['type'] ?? 'unknown')
  const message = entry['message'] as Record<string, unknown> | undefined

  switch (type) {
    case 'session':
      return 'session opened'
    case 'model_change':
      return `model → ${String(entry['modelId'] ?? '?')}`
    case 'thinking_level_change':
      return `thinking → ${String(entry['thinkingLevel'] ?? '?')}`
    case 'service_tier_change':
      return `service tier → ${String(entry['serviceTier'] ?? 'default')}`
    case 'session_info':
      return `titled “${String(entry['name'] ?? '')}”`
    case 'title':
    case 'title_change':
      return `titled “${String(entry['title'] ?? '')}”`
    case 'compaction':
      return `compacted${entry['tokensBefore'] ? ` at ${Number(entry['tokensBefore']).toLocaleString()} tokens` : ''}`
    case 'ttsr_injection':
      return `rules injected: ${((entry['injectedRules'] as string[] | undefined) ?? []).join(', ')}`
    case 'custom':
      return String(entry['customType'] ?? 'custom')
    case 'custom_message':
      return String(entry['customType'] ?? 'inserted context')
    case 'message': {
      const role = String(message?.['role'] ?? '?')
      if (role === 'toolResult') return String(message?.['toolName'] ?? 'tool') + ' result'
      return role
    }
    default:
      return type
  }
}

/** Tool name for an entry, from either the call part or the result message. */
export function toolNameOf(entry: Record<string, unknown>): string | null {
  const message = entry['message'] as Record<string, unknown> | undefined
  if (typeof message?.['toolName'] === 'string') return message['toolName']

  const content = message?.['content']
  if (!Array.isArray(content)) return null
  for (const part of content as Record<string, unknown>[]) {
    if (part['type'] !== 'toolCall') continue
    // A toolCall part names its tool in `name`; a toolResult message uses `toolName`.
    const name = (part['toolName'] as string | undefined) ?? (part['name'] as string | undefined)
    if (name) return name
  }
  return null
}
