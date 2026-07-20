import { describe, expect, it } from 'vitest'
import { computeHunks } from 'common/diff'

describe('computeHunks', () => {
  it('returns no hunks for identical documents', () => {
    expect(computeHunks('a\nb', 'a\nb')).toHaveLength(0)
  })

  it('returns a single add hunk for a pure insertion', () => {
    const result = computeHunks('a\nb\nc', 'a\nb\nnew\nc')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'h0',
      type: 'add',
      baselineStart: 2,
      baselineLines: [],
      proposedLines: ['new']
    })
  })

  it('returns a single delete hunk for a pure deletion', () => {
    const result = computeHunks('a\nb\nc', 'a\nc')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'h0',
      type: 'delete',
      baselineStart: 1,
      baselineLines: ['b'],
      proposedLines: []
    })
  })

  it('returns a replace hunk when lines change', () => {
    const result = computeHunks('a\nold\nc', 'a\nnew\nc')
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'h0',
      type: 'replace',
      baselineLines: ['old'],
      proposedLines: ['new']
    })
  })

  it('returns separate hunks for changes separated by unchanged lines', () => {
    const result = computeHunks('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE')
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      id: 'h0',
      type: 'replace',
      baselineStart: 0,
      baselineLines: ['a'],
      proposedLines: ['A']
    })
    expect(result[1]).toMatchObject({
      id: 'h1',
      type: 'replace',
      baselineStart: 4,
      baselineLines: ['e'],
      proposedLines: ['E']
    })
  })

  it('produces identical hunks for CRLF and LF input', () => {
    const crlf = computeHunks('a\r\nold\r\nc', 'a\r\nnew\r\nc')
    const lf = computeHunks('a\nold\nc', 'a\nnew\nc')
    expect(crlf).toEqual(lf)
    expect(crlf[0].proposedLines).toEqual(['new'])
  })

  it('treats mixed line endings as equal content', () => {
    expect(computeHunks('a\r\nb\nc', 'a\nb\nc')).toHaveLength(0)
  })

  it('ignores a leading BOM', () => {
    expect(computeHunks('﻿a\nb', 'a\nb')).toHaveLength(0)
  })
})
