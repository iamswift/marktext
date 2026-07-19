import { describe, expect, it } from 'vitest'
import { computeLineWordDiff, computeMergedWordDiff } from 'common/diff/wordDiff'

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

describe('computeMergedWordDiff', () => {
  // Exact whitespace attachment below is jsdiff's, verified against the library
  // rather than assumed. The load-bearing invariants — asserted throughout — are
  // that prop spans concatenate to the proposed text and every deletion offset
  // indexes into it, which is what the inline renderer relies on.
  it('returns prop spans covering the whole proposed text', () => {
    const { prop } = computeMergedWordDiff('the priting industry', 'the printing industry')
    expect(prop.map((s) => s.text).join('')).toBe('the printing industry')
    expect(prop.filter((s) => s.changed).map((s) => s.text)).toEqual(['printing'])
  })

  it('anchors a deletion at its offset in the proposed text', () => {
    const propText = 'keep this here'
    const { prop, deletions } = computeMergedWordDiff('keep this extra word here', propText)
    expect(deletions).toEqual([{ text: 'extra word ', offset: 'keep this '.length }])
    expect(prop.map((s) => s.text).join('')).toBe(propText)
    expect(propText.slice(0, deletions[0].offset)).toBe('keep this ')
  })

  it('anchors a replacement deletion at the start of its replacement run', () => {
    const { prop, deletions } = computeMergedWordDiff('aaa bbb ccc', 'aaa xxx ccc')
    expect(deletions).toEqual([{ text: 'bbb', offset: 'aaa '.length }])
    expect(prop.filter((s) => s.changed).map((s) => s.text)).toEqual(['xxx'])
  })

  it('merges adjacent removed parts into one deletion run', () => {
    const { deletions } = computeMergedWordDiff('a one two b', 'a b')
    expect(deletions).toHaveLength(1)
    expect(deletions[0].text).toBe('one two ')
  })

  it('returns no deletions when nothing was removed', () => {
    const { prop, deletions } = computeMergedWordDiff('same text', 'same text plus more')
    expect(deletions).toEqual([])
    expect(prop.map((s) => s.text).join('')).toBe('same text plus more')
  })

  it('keeps every deletion offset within the proposed text', () => {
    const propText = 'as a result generated text stays entirely free of strange words'
    const { prop, deletions } = computeMergedWordDiff(
      'the generated text is therefore always free from strange words',
      propText
    )
    expect(prop.map((s) => s.text).join('')).toBe(propText)
    expect(deletions.length).toBeGreaterThan(0)
    for (const run of deletions) {
      expect(run.offset).toBeGreaterThanOrEqual(0)
      expect(run.offset).toBeLessThanOrEqual(propText.length)
    }
    // offsets are non-decreasing, so splicing last-to-first cannot invalidate an
    // earlier anchor
    const offsets = deletions.map((d) => d.offset)
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets)
  })
})
