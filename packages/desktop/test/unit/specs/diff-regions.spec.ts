import { describe, expect, it } from 'vitest'
import { computeHunks } from 'common/diff'
import type { HunkDecision } from 'common/diff/resolve'
import {
  annotateMerged,
  computeRegions,
  computeUnsafeLineFlags
} from 'common/diff/regions'

const noDecisions = new Map<string, HunkDecision>()

describe('computeUnsafeLineFlags', () => {
  it('flags a fenced code block including its fence lines', () => {
    expect(computeUnsafeLineFlags(['```', 'code', '```'])).toEqual([true, true, true])
  })

  it('does not close a backtick fence on a line with an info string', () => {
    expect(computeUnsafeLineFlags(['```', 'code', '```js', 'more', '```'])).toEqual([
      true,
      true,
      true,
      true,
      true
    ])
  })

  it('flags closed front matter', () => {
    expect(computeUnsafeLineFlags(['---', 'title: x', '---', 'body'])).toEqual([
      true,
      true,
      true,
      false
    ])
  })

  it('treats unclosed front matter as a plain thematic break', () => {
    expect(computeUnsafeLineFlags(['---', 'a', 'b'])).toEqual([false, false, false])
  })

  it('flags an unclosed fence to the end of input', () => {
    expect(computeUnsafeLineFlags(['x', '```', 'tail'])).toEqual([false, true, true])
  })
})

describe('annotateMerged', () => {
  it('expands an undecided hunk to deleted then added lines', () => {
    const base = 'a\nold\nc'
    const hunks = computeHunks(base, 'a\nnew\nc')
    expect(annotateMerged(base, hunks, noDecisions)).toEqual([
      { text: 'a', kind: 'context' },
      { text: 'old', kind: 'del', hunkId: 'h0' },
      { text: 'new', kind: 'add', hunkId: 'h0' },
      { text: 'c', kind: 'context' }
    ])
  })

  it('melts a decided hunk into context lines', () => {
    const base = 'a\nold\nc'
    const hunks = computeHunks(base, 'a\nnew\nc')
    const accepted = new Map<string, HunkDecision>([['h0', { kind: 'accept' }]])
    expect(annotateMerged(base, hunks, accepted)).toEqual([
      { text: 'a', kind: 'context' },
      { text: 'new', kind: 'context' },
      { text: 'c', kind: 'context' }
    ])
  })
})

describe('computeRegions', () => {
  it('keeps a fence containing a hunk atomic within one region', () => {
    const base = 'para\n\n```js\nold code\n```\n\ntail'
    const prop = 'para\n\n```js\nnew code\n```\n\ntail'
    const hunks = computeHunks(base, prop)
    const segments = computeRegions(annotateMerged(base, hunks, noDecisions))
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({
      kind: 'region',
      hunkIds: ['h0'],
      parts: [
        { role: 'context', markdown: 'para\n\n```js' },
        { role: 'deleted', hunkId: 'h0', markdown: 'old code' },
        { role: 'added', hunkId: 'h0', markdown: 'new code' },
        { role: 'context', markdown: '```\n' }
      ]
    })
    expect(segments[1]).toEqual({ kind: 'unchanged', markdown: 'tail' })
  })

  it('separates hunks that have a blank line between them', () => {
    const base = 'a\n\nb'
    const hunks = computeHunks(base, 'A\n\nB')
    const segments = computeRegions(annotateMerged(base, hunks, noDecisions))
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ kind: 'region', hunkIds: ['h0'] })
    expect(segments[1]).toMatchObject({ kind: 'region', hunkIds: ['h1'] })
  })

  it('merges hunks with no blank line between them into one region', () => {
    const base = 'a\nkeep\nb'
    const hunks = computeHunks(base, 'A\nkeep\nB')
    const segments = computeRegions(annotateMerged(base, hunks, noDecisions))
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({ kind: 'region', hunkIds: ['h0', 'h1'] })
  })

  it('keeps front matter inside the unchanged segment', () => {
    const base = '---\ntitle: x\n---\n\nold body'
    const prop = '---\ntitle: x\n---\n\nnew body'
    const hunks = computeHunks(base, prop)
    const segments = computeRegions(annotateMerged(base, hunks, noDecisions))
    expect(segments).toHaveLength(2)
    expect(segments[0]).toEqual({ kind: 'unchanged', markdown: '---\ntitle: x\n---\n' })
    expect(segments[1]).toMatchObject({ kind: 'region', hunkIds: ['h0'] })
  })

  it('renders a fully decided document as a single unchanged segment', () => {
    const base = 'a\nold\nc'
    const hunks = computeHunks(base, 'a\nnew\nc')
    const rejected = new Map<string, HunkDecision>([['h0', { kind: 'reject' }]])
    const segments = computeRegions(annotateMerged(base, hunks, rejected))
    expect(segments).toEqual([{ kind: 'unchanged', markdown: 'a\nold\nc' }])
  })

  it('handles an addition at the end of the document', () => {
    const base = 'x\ny'
    const hunks = computeHunks(base, 'x\ny\nz')
    const segments = computeRegions(annotateMerged(base, hunks, noDecisions))
    const region = segments.find((s) => s.kind === 'region')
    expect(region).toMatchObject({
      kind: 'region',
      parts: expect.arrayContaining([{ role: 'added', hunkId: 'h0', markdown: 'z' }])
    })
  })
})
