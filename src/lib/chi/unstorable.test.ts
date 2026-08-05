import { describe, expect, it } from 'vitest'

import {
  decodeString,
  decodeUnstorable,
  encodeString,
  encodeUnstorable,
  hasUnstorable,
  NUL,
  SENTINEL,
  stringHasUnstorable,
} from './unstorable.ts'

const LONE_HIGH = '\ud83d' // high surrogate with no low partner
const LONE_LOW = '\udc96' // low surrogate with no high partner
const VALID_PAIR = '💖' // 💖 — a legitimate pair, must not be touched

describe('unstorable characters', () => {
  it('leaves ordinary text and valid astral characters alone', () => {
    expect(encodeString('hello world')).toBe('hello world')
    expect(stringHasUnstorable(VALID_PAIR)).toBe(false)
    expect(encodeString(`a ${VALID_PAIR} b`)).toBe(`a ${VALID_PAIR} b`)
    // Other control characters are valid in jsonb and must not be touched: the
    // corpus has 3,928 escaped ESC characters from terminal output.
    expect(encodeString('[31mred[0m')).toBe('[31mred[0m')
    expect(hasUnstorable({ a: '', b: ['x', VALID_PAIR] })).toBe(false)
  })

  it('round-trips NULs', () => {
    const s = `a${NUL}b${NUL}${NUL}c`
    expect(stringHasUnstorable(s)).toBe(true)
    expect(encodeString(s)).not.toContain(NUL)
    expect(decodeString(encodeString(s))).toBe(s)
  })

  it('round-trips lone surrogates, high and low', () => {
    for (const lone of [LONE_HIGH, LONE_LOW]) {
      const s = `x${lone}y`
      expect(stringHasUnstorable(s)).toBe(true)
      const encoded = encodeString(s)
      // The encoded form must be representable as UTF-8, which a lone surrogate is not.
      expect(Buffer.from(encoded, 'utf8').toString('utf8')).toBe(encoded)
      expect(decodeString(encoded)).toBe(s)
    }
  })

  it('keeps a valid pair intact while escaping a lone surrogate beside it', () => {
    const s = `${VALID_PAIR}${LONE_HIGH}${VALID_PAIR}`
    const decoded = decodeString(encodeString(s))
    expect(decoded).toBe(s)
    expect(decoded.length).toBe(s.length)
  })

  it('round-trips text that already contains the sentinel', () => {
    // Why the sentinel is escaped rather than assumed absent: the corpus does
    // contain Private Use Area characters.
    const s = `${SENTINEL}x${NUL}${SENTINEL}${SENTINEL}u0041${LONE_LOW}`
    expect(decodeString(encodeString(s))).toBe(s)
  })

  it('does not mistake escaped-looking source text for an escape', () => {
    // Source text that literally reads like our own encoding must survive, because
    // the sentinel in it gets doubled on the way in.
    const s = `${SENTINEL}0${SENTINEL}ud83d`
    expect(decodeString(encodeString(s))).toBe(s)
  })

  it('round-trips through keys, arrays, and nested objects', () => {
    const value = {
      [`key${NUL}`]: 'v',
      nested: { deep: [`a${LONE_HIGH}`, 2, null, { [`${SENTINEL}k`]: `${NUL}` }] },
      untouched: 'plain',
    }
    expect(hasUnstorable(value)).toBe(true)
    const encoded = encodeUnstorable(value)
    const json = JSON.stringify(encoded)
    expect(json).not.toContain(NUL)
    expect(Buffer.from(json, 'utf8').toString('utf8')).toBe(json)
    expect(decodeUnstorable(encoded)).toEqual(value)
  })

  it('preserves non-string types exactly', () => {
    const value = { n: 0.030985000000000002, b: false, z: null, arr: [1, 2, 3] }
    expect(decodeUnstorable(encodeUnstorable(value))).toEqual(value)
  })

  it('leaves a value that was never encoded alone', () => {
    expect(decodeString('plain')).toBe('plain')
    expect(decodeString(SENTINEL)).toBe(SENTINEL)
  })
})
