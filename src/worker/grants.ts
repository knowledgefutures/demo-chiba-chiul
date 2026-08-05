/**
 * What a persona may see. Pure functions, no I/O — so the rules can be tested
 * exhaustively rather than exercised through HTTP.
 *
 * The whole access model is here. Routes call `resolveAccess` once and then filter
 * with it; nothing decides visibility by hiding UI, because a demo that hides rather
 * than filters teaches the wrong thing about the product it stands for.
 */

/** Chi's z vocabulary, used as the permission ladder. See db/schema.ts § grants. */
export const DETAIL_LEVELS = ['none', 'metrics', 'reduced', 'full'] as const
export type Detail = (typeof DETAIL_LEVELS)[number]

export function detailRank(detail: Detail): number {
  return DETAIL_LEVELS.indexOf(detail)
}

/** More permissive of two levels. Adding a grant must never remove access. */
export function maxDetail(a: Detail, b: Detail): Detail {
  return detailRank(a) >= detailRank(b) ? a : b
}

export type Grant = {
  scopeKind: 'all' | 'source'
  scopeValue: string | null
  detail: Detail
  seePrivate: boolean
}

export type Persona = {
  id: string
  label: string
  kind: 'member' | 'steward' | 'outsider'
  sourceLabel: string | null
}

export type Access = {
  persona: Persona
  /** Resolved detail per source label, plus the wildcard fallback. */
  bySource: Map<string, { detail: Detail; seePrivate: boolean }>
  wildcard: { detail: Detail; seePrivate: boolean }
}

/**
 * Fold a persona's grants into a lookup.
 *
 * Most-specific-wins: a `source` grant decides that source outright, even when it is
 * *less* permissive than a wildcard — that is what makes "everyone may see metrics,
 * but User 2 specifically has opted out" expressible. Within one specificity the more
 * permissive level wins.
 */
export function resolveAccess(persona: Persona, grants: readonly Grant[]): Access {
  let wildcard = { detail: 'none' as Detail, seePrivate: false }
  const bySource = new Map<string, { detail: Detail; seePrivate: boolean }>()

  for (const grant of grants) {
    if (grant.scopeKind === 'all') {
      wildcard = {
        detail: maxDetail(wildcard.detail, grant.detail),
        seePrivate: wildcard.seePrivate || grant.seePrivate,
      }
    }
  }

  for (const grant of grants) {
    if (grant.scopeKind !== 'source' || grant.scopeValue === null) continue
    const existing = bySource.get(grant.scopeValue)
    bySource.set(grant.scopeValue, {
      detail: existing ? maxDetail(existing.detail, grant.detail) : grant.detail,
      seePrivate: (existing?.seePrivate ?? false) || grant.seePrivate,
    })
  }

  return { persona, bySource, wildcard }
}

/** Detail this persona has for one source label. */
export function detailFor(access: Access, sourceLabel: string): Detail {
  return (access.bySource.get(sourceLabel) ?? access.wildcard).detail
}

export function seePrivateFor(access: Access, sourceLabel: string): boolean {
  return (access.bySource.get(sourceLabel) ?? access.wildcard).seePrivate
}

export function canSeeSession(access: Access, sourceLabel: string): boolean {
  return detailFor(access, sourceLabel) !== 'none'
}

/** Whether raw z=0 entries are readable for a source. */
export function canReadEntries(access: Access, sourceLabel: string): boolean {
  return detailFor(access, sourceLabel) === 'full'
}

/** Whether reduced (z>=1) entries are readable. `full` implies it. */
export function canReadReduced(access: Access, sourceLabel: string): boolean {
  const detail = detailFor(access, sourceLabel)
  return detail === 'full' || detail === 'reduced'
}

/**
 * Fields stripped from a Session row when the persona may not see private ones.
 *
 * Mirrors the `private: true` markings in the pushed schema, so the surface and the
 * collection agree on what "private" means rather than each having an opinion.
 */
export const PRIVATE_SESSION_FIELDS = ['cwd'] as const

export function filterSession<T extends Record<string, unknown>>(
  session: T,
  access: Access,
  sourceLabel: string,
): T {
  if (seePrivateFor(access, sourceLabel)) return session
  const out = { ...session }
  for (const field of PRIVATE_SESSION_FIELDS) delete out[field]
  return out
}

/**
 * The reason a persona cannot see something, in words a reader can act on.
 *
 * Returned to the client and rendered, rather than silently showing an empty list —
 * "you are seeing 29 of 65 sessions, because…" is the thing the demo is trying to
 * teach. An empty page teaches nothing.
 */
export function explainDetail(detail: Detail, sourceLabel: string): string {
  switch (detail) {
    case 'full':
      return `Raw session records for ${sourceLabel}.`
    case 'reduced':
      return `Summaries only for ${sourceLabel} — reduced levels (z≥1), never raw records.`
    case 'metrics':
      return `Shape and cost only for ${sourceLabel}. No session content.`
    case 'none':
      return `No access to ${sourceLabel}.`
  }
}
