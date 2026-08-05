import { describe, expect, it } from 'vitest'

import {
  canReadEntries,
  canReadReduced,
  canSeeSession,
  detailFor,
  filterSession,
  maxDetail,
  resolveAccess,
  seePrivateFor,
} from './grants.ts'
import type { Grant, Persona } from './grants.ts'

const member: Persona = { id: 'p1', label: 'User 1', kind: 'member', sourceLabel: 'User 1' }
const steward: Persona = { id: 'p2', label: 'Team steward', kind: 'steward', sourceLabel: null }
const outsider: Persona = { id: 'p3', label: 'Outsider', kind: 'outsider', sourceLabel: null }

const grant = (g: Partial<Grant>): Grant => ({
  scopeKind: 'all',
  scopeValue: null,
  detail: 'metrics',
  seePrivate: false,
  ...g,
})

describe('maxDetail', () => {
  it('orders the ladder none < metrics < reduced < full', () => {
    expect(maxDetail('none', 'metrics')).toBe('metrics')
    expect(maxDetail('metrics', 'reduced')).toBe('reduced')
    expect(maxDetail('reduced', 'full')).toBe('full')
    expect(maxDetail('full', 'none')).toBe('full')
  })
})

describe('resolveAccess', () => {
  it('denies everything when a persona has no grants', () => {
    const access = resolveAccess(outsider, [])
    expect(detailFor(access, 'User 1')).toBe('none')
    expect(canSeeSession(access, 'User 1')).toBe(false)
  })

  it('gives a member full access to their own source and metrics elsewhere', () => {
    const access = resolveAccess(member, [
      grant({ scopeKind: 'source', scopeValue: 'User 1', detail: 'full', seePrivate: true }),
      grant({ scopeKind: 'all', detail: 'metrics' }),
    ])

    expect(detailFor(access, 'User 1')).toBe('full')
    expect(canReadEntries(access, 'User 1')).toBe(true)
    expect(seePrivateFor(access, 'User 1')).toBe(true)

    expect(detailFor(access, 'User 2')).toBe('metrics')
    expect(canReadEntries(access, 'User 2')).toBe(false)
    expect(canSeeSession(access, 'User 2')).toBe(true)
    expect(seePrivateFor(access, 'User 2')).toBe(false)
  })

  it('lets a steward read summaries everywhere but never raw records or private fields', () => {
    const access = resolveAccess(steward, [grant({ scopeKind: 'all', detail: 'reduced' })])
    for (const source of ['User 1', 'User 2', 'Unattributed']) {
      expect(canReadReduced(access, source), source).toBe(true)
      expect(canReadEntries(access, source), source).toBe(false)
      expect(seePrivateFor(access, source), source).toBe(false)
    }
  })

  /**
   * The case that makes the model worth having: a specific grant *narrows* a wildcard.
   * "Everyone may see metrics, except User 2 who opted out" is only expressible if
   * source grants win over `all` even when less permissive.
   */
  it('lets a specific source grant narrow a broader wildcard', () => {
    const access = resolveAccess(steward, [
      grant({ scopeKind: 'all', detail: 'reduced' }),
      grant({ scopeKind: 'source', scopeValue: 'User 2', detail: 'none' }),
    ])
    expect(detailFor(access, 'User 1')).toBe('reduced')
    expect(detailFor(access, 'User 2')).toBe('none')
    expect(canSeeSession(access, 'User 2')).toBe(false)
  })

  it('takes the more permissive of two grants at the same specificity', () => {
    const access = resolveAccess(member, [
      grant({ scopeKind: 'source', scopeValue: 'User 1', detail: 'metrics' }),
      grant({ scopeKind: 'source', scopeValue: 'User 1', detail: 'full', seePrivate: true }),
    ])
    expect(detailFor(access, 'User 1')).toBe('full')
    expect(seePrivateFor(access, 'User 1')).toBe(true)
    // Order must not matter.
    const reversed = resolveAccess(member, [
      grant({ scopeKind: 'source', scopeValue: 'User 1', detail: 'full', seePrivate: true }),
      grant({ scopeKind: 'source', scopeValue: 'User 1', detail: 'metrics' }),
    ])
    expect(detailFor(reversed, 'User 1')).toBe('full')
  })

  it('ignores a source grant with no value rather than treating it as a wildcard', () => {
    const access = resolveAccess(member, [
      grant({ scopeKind: 'source', scopeValue: null, detail: 'full' }),
    ])
    expect(detailFor(access, 'User 1')).toBe('none')
  })
})

describe('filterSession', () => {
  const session = { sessionId: 's1', source: 'User 1', cwd: '/home/someone/repo', costUsd: 1.5 }

  it('strips private fields when the persona may not see them', () => {
    const access = resolveAccess(outsider, [grant({ scopeKind: 'all', detail: 'metrics' })])
    const filtered = filterSession(session, access, 'User 1')
    expect('cwd' in filtered).toBe(false)
    expect(filtered.costUsd).toBe(1.5)
    expect(filtered.source).toBe('User 1')
  })

  it('keeps them for a persona that may', () => {
    const access = resolveAccess(member, [
      grant({ scopeKind: 'source', scopeValue: 'User 1', detail: 'full', seePrivate: true }),
    ])
    expect(filterSession(session, access, 'User 1').cwd).toBe('/home/someone/repo')
  })

  it('does not mutate the input', () => {
    const access = resolveAccess(outsider, [grant({ scopeKind: 'all', detail: 'metrics' })])
    filterSession(session, access, 'User 1')
    expect(session.cwd).toBe('/home/someone/repo')
  })

  /**
   * Private-field visibility is decided per source, not per persona: a member sees
   * their own machine paths and not anyone else's. Getting this wrong would leak the
   * exact field the corpus terms care about.
   */
  it('decides private-field visibility per source, not globally', () => {
    const access = resolveAccess(member, [
      grant({ scopeKind: 'source', scopeValue: 'User 1', detail: 'full', seePrivate: true }),
      grant({ scopeKind: 'all', detail: 'metrics' }),
    ])
    expect('cwd' in filterSession(session, access, 'User 1')).toBe(true)
    expect('cwd' in filterSession(session, access, 'User 2')).toBe(false)
  })
})
