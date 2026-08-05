/**
 * The JSON Schemas pushed with every version.
 *
 * Two properties are load-bearing:
 *
 * 1. `Entry.entry` is an unconstrained object. Underlay's extra-field check reads
 *    only the *top level* of `data` (`negotiate.ts`, "Check for extra fields"), so
 *    anything inside `entry` passes through unexamined. That is what lets an
 *    unknown future record type or content part survive the round trip without a
 *    schema change here — which is the whole claim.
 *
 * 2. `private: true` on `Session.cwd`. Underlay's AJV runs `strict: false`, so the
 *    unknown keyword is carried rather than rejected, and `getPrivateFields`
 *    strips the field server-side for callers without access. That is the privacy
 *    demo, and it is a schema property rather than application code.
 *
 * Schemas are content-addressed upstream: two collections defining these types
 * identically share one schema row and one schema hash, which is what makes the
 * per-person and per-repo layouts align automatically instead of by convention.
 */

export const ENTRY_SCHEMA = {
  type: 'object',
  title: 'Entry',
  description:
    'One portable Pi v3 session entry at one reduction level. `entry` is the v3 record ' +
    'verbatim — valid in, valid out, at every z.',
  properties: {
    sessionId: { type: 'string', description: 'Session this entry belongs to.' },
    seq: {
      type: 'integer',
      minimum: 0,
      description: 'Position in the source JSONL. Reproduces file order exactly.',
    },
    z: {
      type: 'integer',
      description:
        'Reduction level. 0 = raw source records. z > 0 is leaf-relative, z < 0 root-relative ' +
        '(chi-commons DESIGN.md). Denormalised from the Reduction for cheap filtering; the ' +
        'Reduction is the real discriminator, because (strategy, z) together identify a level.',
    },
    reductionId: {
      type: ['string', 'null'],
      description: 'The Reduction that produced this entry. Null at z=0.',
    },
    entry: {
      type: 'object',
      description: 'The Pi v3 entry, unmodified. Intentionally unconstrained.',
    },
    pgEscaped: {
      type: 'boolean',
      description:
        'True when strings in `entry` carry a reversible encoding of characters Postgres JSON ' +
        'cannot store: U+0000 and lone surrogates. Absent means the entry is exactly as ' +
        'recorded. Reversed on read; see src/lib/chi/unstorable.ts for the encoding.',
    },
  },
  required: ['sessionId', 'seq', 'z', 'entry'],
  additionalProperties: false,
} as const

export const SESSION_SCHEMA = {
  type: 'object',
  title: 'Session',
  description: 'Derived metadata spine for one session. A projection, not valid v3.',
  properties: {
    sessionId: { type: 'string' },
    title: { type: ['string', 'null'] },
    startedAt: { type: ['string', 'null'] },
    lastAt: { type: ['string', 'null'] },
    source: {
      type: 'string',
      description:
        'Recording machine, as a neutral label ("User 1", "Unattributed"). A machine, not a ' +
        'person: one root is a shared environment, and 40 of 65 corpus sessions have no cwd.',
    },
    repo: { type: ['string', 'null'] },
    cwd: {
      type: ['string', 'null'],
      description: 'Recording working directory. Machine-local and identifying.',
      private: true,
    },
    entryCount: { type: 'integer', minimum: 0 },
    messageCount: { type: 'integer', minimum: 0 },
    approxTokens: {
      type: 'integer',
      minimum: 0,
      description: 'Model-visible tokens at ~4 chars/token: text, thinking, tool-call arguments.',
    },
    costUsd: { type: 'number', minimum: 0 },
    models: { type: 'array', items: { type: 'string' } },
    leafEntryIds: { type: 'array', items: { type: 'string' } },
    trailingNewline: {
      type: 'boolean',
      description: 'Whether the source file ended with a newline. Needed for exact reassembly.',
    },
  },
  required: ['sessionId', 'source', 'entryCount'],
  additionalProperties: false,
} as const

export const REDUCTION_SCHEMA = {
  type: 'object',
  title: 'Reduction',
  description:
    'One derivation that produced entries at a coarser level. Fields follow Chi ARCHITECTURE.md: ' +
    '"every output records exact input hashes/IDs, source repos/sessions, reducer and prompt ' +
    'versions, model, fan-in, and authorization scope."',
  properties: {
    sessionId: { type: 'string' },
    strategy: {
      type: 'string',
      description: 'Reduction topology, e.g. pairwise | single-shot. Orthogonal to z.',
    },
    z: { type: 'integer' },
    reducerVersion: { type: 'integer' },
    promptVersion: { type: ['string', 'null'] },
    model: { type: ['string', 'null'] },
    fanIn: { type: ['integer', 'null'] },
    generatedAt: { type: ['string', 'null'] },
    sourceEntryIds: { type: 'array', items: { type: 'string' } },
    sourceHashes: { type: 'array', items: { type: 'string' } },
    authorizationScope: { type: ['string', 'null'] },
  },
  required: ['sessionId', 'strategy', 'z', 'reducerVersion'],
  additionalProperties: false,
} as const

export const METRICS_SCHEMA = {
  type: 'object',
  title: 'Metrics',
  description:
    'Deterministic field-algebra output over a set of entries. A projection: explicitly not v3, ' +
    'and rebuildable from Entry at any time.',
  properties: {
    scope: { type: 'string', description: 'session | source | repo | collection' },
    scopeId: { type: 'string' },
    costUsd: { type: 'number', minimum: 0 },
    tokens: { type: 'object' },
    toolCalls: { type: 'object' },
    entryTypes: { type: 'object' },
    roles: { type: 'object' },
    models: { type: 'array', items: { type: 'string' } },
    images: { type: 'integer', minimum: 0 },
  },
  required: ['scope', 'scopeId'],
  additionalProperties: false,
} as const

export const CHIUL_SCHEMAS: Record<string, Record<string, unknown>> = {
  Entry: ENTRY_SCHEMA as unknown as Record<string, unknown>,
  Session: SESSION_SCHEMA as unknown as Record<string, unknown>,
  Reduction: REDUCTION_SCHEMA as unknown as Record<string, unknown>,
  Metrics: METRICS_SCHEMA as unknown as Record<string, unknown>,
}
