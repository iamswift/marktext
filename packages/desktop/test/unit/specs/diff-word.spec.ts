import { describe, expect, it } from 'vitest'
import { computeLineWordDiff } from 'common/diff/wordDiff'

describe('computeLineWordDiff', () => {
  it('marks a replaced word as changed on both sides', () => {
    const result = computeLineWordDiff('the quick fox', 'the slow fox')
    expect(result.base[0].text).toBe('the ')
    expect(result.base[0].changed).toBe(false)
    expect(result.base[1].text).toBe('quick')
    expect(result.base[1].changed).toBe(true)
    expect(result.prop[0].text).toBe('the ')
    expect(result.prop[0].changed).toBe(false)
    expect(result.prop[1].text).toBe('slow')
    expect(result.prop[1].changed).toBe(true)
    expect(result.base.map((s) => s.text).join('')).toBe('the quick fox')
    expect(result.prop.map((s) => s.text).join('')).toBe('the slow fox')
  })

  it('returns single unchanged spans for identical lines', () => {
    const result = computeLineWordDiff('same line', 'same line')
    expect(result.base).toEqual([{ text: 'same line', changed: false }])
    expect(result.prop).toEqual([{ text: 'same line', changed: false }])
  })

  it('marks a pure insertion only on the proposed side', () => {
    const result = computeLineWordDiff('a c', 'a b c')
    expect(result.base.every((s) => s.changed === false)).toBe(true)
    expect(result.prop.some((s) => s.changed === true && s.text.includes('b'))).toBe(true)
  })

  it('handles a whitespace-only change', () => {
    const result = computeLineWordDiff('a b', 'a  b')
    expect(result.prop.map((s) => s.text).join('')).toBe('a  b')
    expect(result.prop.some((s) => s.changed === true)).toBe(true)
  })
})
