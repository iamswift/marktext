import { describe, expect, it } from 'vitest'
import type { DiffHunk } from 'common/diff'
import { classifyHunk, computeHunkMetrics } from 'common/diff/classify'

const replaceHunk = (baselineLines: string[], proposedLines: string[]): DiffHunk => ({
  id: 'h0',
  index: 0,
  type: 'replace',
  baselineStart: 0,
  baselineLines,
  proposedStart: 0,
  proposedLines,
  contentKey: 'test'
})

const addHunk = (proposedLines: string[]): DiffHunk => ({
  id: 'h0',
  index: 0,
  type: 'add',
  baselineStart: 0,
  baselineLines: [],
  proposedStart: 0,
  proposedLines,
  contentKey: 'test'
})

const deleteHunk = (baselineLines: string[]): DiffHunk => ({
  id: 'h0',
  index: 0,
  type: 'delete',
  baselineStart: 0,
  baselineLines,
  proposedStart: 0,
  proposedLines: [],
  contentKey: 'test'
})

describe('computeHunkMetrics', () => {
  it('counts a single word swap as one run of two words', () => {
    const m = computeHunkMetrics(
      replaceHunk(['the priting industry'], ['the printing industry'])
    )
    expect(m).toEqual({ maxRunWords: 2, runCount: 1, linesBefore: 1, linesAfter: 1 })
  })

  it('counts separate edits as separate runs and takes the largest', () => {
    const m = computeHunkMetrics(
      replaceHunk(
        ['it isnt clear that the old approach was always free from errors'],
        ["it isn't clear that a completely different approach stays free of errors"]
      )
    )
    expect(m.runCount).toBeGreaterThanOrEqual(2)
    // "the old approach was always free from" -> "a completely different approach stays free of"
    // is the biggest single run: 7 struck + 8 replacement words = 15
    expect(m.maxRunWords).toBeGreaterThan(8)
  })

  it('measures a run as struck words plus replacement words combined', () => {
    const m = computeHunkMetrics(
      replaceHunk(['aaa bbb ccc ddd'], ['aaa xxx yyy ddd'])
    )
    // "bbb ccc" -> "xxx yyy": 2 + 2 = 4
    expect(m.maxRunWords).toBe(4)
    expect(m.runCount).toBe(1)
  })

  it('spans multiple lines: metrics come from the joined hunk text', () => {
    const m = computeHunkMetrics(
      replaceHunk(['first lien here', 'second lyne here'], ['first line here', 'second line here'])
    )
    expect(m.runCount).toBe(2)
    expect(m.maxRunWords).toBe(2)
    expect(m.linesBefore).toBe(2)
    expect(m.linesAfter).toBe(2)
  })

  it('reports zero runs for identical text', () => {
    const m = computeHunkMetrics(replaceHunk(['same'], ['same']))
    expect(m).toEqual({ maxRunWords: 0, runCount: 0, linesBefore: 1, linesAfter: 1 })
  })
})

describe('classifyHunk', () => {
  it('keeps small word fixes inline, even across multiple lines', () => {
    expect(classifyHunk(replaceHunk(['the priting industry'], ['the printing industry']))).toBe(
      'inline'
    )
    expect(
      classifyHunk(
        replaceHunk(
          ['first lien here', 'second lyne here'],
          ['first line here', 'second line here']
        )
      )
    ).toBe('inline')
  })

  it('stacks a hunk whose largest single edit exceeds the run threshold', () => {
    // One contiguous rewrite sharing no words with its replacement: 6 struck +
    // 6 replacement = 12, over the 8-word bar. A rewrite that happens to reuse
    // words mid-phrase reads as several small edits instead — see the
    // fragmentation case below, which stays inline by design.
    expect(
      classifyHunk(
        replaceHunk(
          ['keep this intro then everything here is completely different wording'],
          ['keep this intro then a totally fresh sentence appears instead']
        )
      )
    ).toBe('stacked')
  })

  it('stacks a paragraph split or merge regardless of edit size', () => {
    expect(
      classifyHunk(
        replaceHunk(['one long paragraph that gets split'], ['one long paragraph', 'that gets split'])
      )
    ).toBe('stacked')
  })

  it('always renders pure add and pure delete hunks inline (they are a single block)', () => {
    expect(classifyHunk(addHunk(['a whole new paragraph with quite a lot of words in it']))).toBe(
      'inline'
    )
    expect(
      classifyHunk(deleteHunk(['a whole removed paragraph with quite a lot of words in it']))
    ).toBe('inline')
  })

  it('keeps many small edits inline (no fragmentation rule)', () => {
    expect(
      classifyHunk(
        replaceHunk(
          ['the text is here and the text is there and the text is everywhere in the text'],
          ['the copy is here and the copy is there and the copy is everywhere in the copy']
        )
      )
    ).toBe('inline')
  })
})
