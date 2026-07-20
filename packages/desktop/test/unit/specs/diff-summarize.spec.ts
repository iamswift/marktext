import { describe, expect, it } from 'vitest'
import type { DiffHunk } from 'common/diff'
import { describeHunk, summarizeHunk } from 'common/diff/summarize'

let seq = 0
const hunk = (
  type: DiffHunk['type'],
  baselineLines: string[],
  proposedLines: string[]
): DiffHunk => ({
  id: `h${seq}`,
  index: 0,
  type,
  baselineStart: 0,
  baselineLines,
  proposedStart: 0,
  proposedLines,
  // Unique per construction so the memo cache never serves a stale descriptor
  // between cases.
  contentKey: `k${seq++}`
})

const replace = (b: string[], p: string[]): DiffHunk => hunk('replace', b, p)
const added = (p: string[]): DiffHunk => hunk('add', [], p)
const removed = (b: string[]): DiffHunk => hunk('delete', b, [])

describe('describeHunk', () => {
  it('counts separate one-word fixes in a single paragraph', () => {
    expect(describeHunk(replace(['the priting industry'], ['the printing industry']))).toEqual({
      key: 'wordsFixed',
      count: 1
    })
    expect(
      describeHunk(
        replace(
          ['the priting industry is essentialy about publising'],
          ['the printing industry is essentially about publishing']
        )
      )
    ).toEqual({ key: 'wordsFixed', count: 3 })
  })

  it('reports paragraph count before word count when a hunk spans blocks', () => {
    // Two paragraphs of one-word typos must read "2 paragraphs revised", not
    // "2 words fixed" — the block count is the more useful summary.
    expect(
      describeHunk(
        replace(
          ['first lien here', '', 'second lyne here'],
          ['first line here', '', 'second line here']
        )
      )
    ).toEqual({ key: 'paragraphsRevised', count: 2 })
  })

  it('calls a single large contiguous run a rewritten sentence', () => {
    expect(
      describeHunk(
        replace(
          ['keep this intro then everything here is completely different wording'],
          ['keep this intro then a totally fresh sentence appears instead']
        )
      )
    ).toEqual({ key: 'sentenceRewritten' })
  })

  it('falls back to a revised paragraph for several mid-sized runs', () => {
    expect(
      describeHunk(
        replace(
          ['alpha beta gamma delta stays here and epsilon zeta eta theta ends it'],
          ['one two three four stays here and five six seven eight ends it']
        )
      )
    ).toEqual({ key: 'paragraphsRevised', count: 1 })
  })

  it('describes pure additions and deletions by block count', () => {
    expect(describeHunk(added(['a brand new paragraph']))).toEqual({
      key: 'paragraphAdded',
      count: 1
    })
    expect(describeHunk(added(['one para', '', 'two para', '', 'three para']))).toEqual({
      key: 'paragraphAdded',
      count: 3
    })
    expect(describeHunk(removed(['a removed paragraph', '', 'and another']))).toEqual({
      key: 'paragraphRemoved',
      count: 2
    })
  })

  it('escapes to a neutral line count for non-prose blocks', () => {
    // "Paragraph" is a lie for lists, headings, tables and code, and the
    // mockup's vocabulary never covers them.
    expect(describeHunk(replace(['- item one'], ['- item won']))).toEqual({
      key: 'linesChanged',
      count: 1
    })
    expect(describeHunk(replace(['## Headng'], ['## Heading']))).toEqual({
      key: 'linesChanged',
      count: 1
    })
    expect(describeHunk(replace(['| a | b |'], ['| a | c |']))).toEqual({
      key: 'linesChanged',
      count: 1
    })
    expect(describeHunk(replace(['const answer = 42'], ['const answer = 43', '```']))).toEqual({
      key: 'linesChanged',
      count: 2
    })
    expect(describeHunk(replace(['    indented code'], ['    indented cod']))).toEqual({
      key: 'linesChanged',
      count: 1
    })
  })
})

describe('summarizeHunk', () => {
  it('summarizes a small replacement as old to new', () => {
    expect(summarizeHunk(replace(['the priting industry'], ['the printing industry']))).toEqual({
      kind: 'replace',
      oldText: 'priting',
      newText: 'printing'
    })
  })

  it('joins several changed words with commas', () => {
    const delta = summarizeHunk(
      replace(
        ['the priting industry is essentialy about publising'],
        ['the printing industry is essentially about publishing']
      )
    )
    expect(delta).toEqual({
      kind: 'replace',
      oldText: 'priting, essentialy, publising',
      newText: 'printing, essentially, publishing'
    })
    // Guards the 42-char budget the boundary cases below pin.
    expect((delta as { oldText: string }).oldText.length).toBeLessThanOrEqual(42)
  })

  it('keeps a replacement whose old text is exactly at the limit', () => {
    // 'aaaaaaaa, bbbbbbbb, cccccccc, dddddddddddd' is exactly 42 chars.
    const delta = summarizeHunk(
      replace(
        ['x aaaaaaaa y bbbbbbbb z cccccccc w dddddddddddd'],
        ['x 11111111 y 22222222 z 33333333 w 444444444444']
      )
    )
    expect((delta as { oldText: string }).oldText).toHaveLength(42)
    expect(delta.kind).toBe('replace')
  })

  it('falls back to a bulk line count once the old text exceeds the limit', () => {
    const delta = summarizeHunk(
      replace(
        ['x aaaaaaaa y bbbbbbbb z cccccccc w ddddddddddddd'],
        ['x 11111111 y 22222222 z 33333333 w 4444444444444']
      )
    )
    expect(delta).toEqual({ kind: 'bulk', lines: 1 })
  })

  it('previews the new text for a pure addition', () => {
    expect(summarizeHunk(added(['a short new line']))).toEqual({
      kind: 'preview',
      side: 'new',
      text: 'a short new line',
      truncated: false
    })

    const long = 'w'.repeat(60)
    const delta = summarizeHunk(added([long]))
    expect(delta).toEqual({ kind: 'preview', side: 'new', text: 'w'.repeat(48), truncated: true })
  })

  it('previews the old text for a pure deletion', () => {
    expect(summarizeHunk(removed(['a removed line']))).toEqual({
      kind: 'preview',
      side: 'old',
      text: 'a removed line',
      truncated: false
    })
  })

  it('previews the insertion when a replace hunk only adds words', () => {
    expect(summarizeHunk(replace(['keep this here'], ['keep this extra word here']))).toEqual({
      kind: 'preview',
      side: 'new',
      text: 'extra word',
      truncated: false
    })
  })

  it('reports a multi-paragraph rewrite as a bulk line count', () => {
    const delta = summarizeHunk(
      replace(
        ['completely different opening wording here', '', 'and a second wholly changed line'],
        ['an entirely fresh opening instead', '', 'plus another altogether new line']
      )
    )
    // lines counts the baseline side including the blank separator.
    expect(delta).toEqual({ kind: 'bulk', lines: 3 })
  })

  it('clamps a pathologically long replacement so the card cannot grow unbounded', () => {
    const delta = summarizeHunk(replace(['swap'], [`${'long '.repeat(40)}tail`]))
    expect(delta.kind).toBe('replace')
    expect((delta as { newText: string }).newText.length).toBeLessThanOrEqual(97)
    expect((delta as { newText: string }).newText.endsWith('…')).toBe(true)
  })
})
