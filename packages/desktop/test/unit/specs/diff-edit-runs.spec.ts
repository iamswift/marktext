import { describe, expect, it } from 'vitest'
import type { DiffHunk } from 'common/diff'
import { computeEditRuns } from 'common/diff/editRuns'

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
  // Unique per construction so nothing accidentally keys off a shared fingerprint.
  contentKey: `k${seq++}`
})

const replace = (b: string[], p: string[]): DiffHunk => hunk('replace', b, p)
const added = (p: string[]): DiffHunk => hunk('add', [], p)
const removed = (b: string[]): DiffHunk => hunk('delete', b, [])

/** Asserts every run's offsets round-trip back to its own text, per source. */
const expectRunsRoundTrip = (h: DiffHunk, runs: ReturnType<typeof computeEditRuns>): void => {
  const baselineText = h.baselineLines.join('\n')
  const proposedText = h.proposedLines.join('\n')
  for (const run of runs) {
    expect(baselineText.slice(run.baseStart, run.baseEnd)).toBe(run.delText)
    expect(proposedText.slice(run.propStart, run.propEnd)).toBe(run.addText)
  }
}

describe('computeEditRuns', () => {
  it('returns no runs for a pure addition', () => {
    expect(computeEditRuns(added(['a brand new paragraph']))).toEqual([])
  })

  it('returns no runs for a pure deletion', () => {
    expect(computeEditRuns(removed(['a removed paragraph']))).toEqual([])
  })

  it('returns no runs when baseline and proposed text are identical', () => {
    expect(computeEditRuns(replace(['same text'], ['same text']))).toEqual([])
  })

  it('produces a single run for one swapped word', () => {
    const h = replace(['the priting industry'], ['the printing industry'])
    const runs = computeEditRuns(h)
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      index: 0,
      id: `${h.id}:0`,
      delText: 'priting',
      addText: 'printing'
    })
    expectRunsRoundTrip(h, runs)
  })

  it('counts three separate runs for three isolated typo fixes, matching labelMetrics', () => {
    // Each fix is separated by a multi-word equal span ("industry is", "about"),
    // so this must produce 3 runs — the same count the margin card label uses
    // (see summarize.ts's labelMetrics, describeHunk 'wordsFixed' count: 3).
    const h = replace(
      ['the priting industry is essentialy about publising'],
      ['the printing industry is essentially about publishing']
    )
    const runs = computeEditRuns(h)
    expect(runs).toHaveLength(3)
    expect(runs.map((r) => r.delText)).toEqual(['priting', 'essentialy', 'publising'])
    expect(runs.map((r) => r.addText)).toEqual(['printing', 'essentially', 'publishing'])
    expectRunsRoundTrip(h, runs)
  })

  it('does not split a run on a single shared word (labelMetrics semantics, not classify.ts)', () => {
    // jsdiff's diffWordsWithSpace links each swapped word with a single-space
    // equal token (wordCount 0), which must NOT reset the run — only a
    // multi-word equal span may. So the four alpha/beta/gamma/delta swaps and
    // the four epsilon/zeta/eta/theta swaps each collapse into ONE run apiece
    // (2 runs total), never 4+4. This mirrors the "falls back to a revised
    // paragraph" fixture in diff-summarize.spec.ts, which relies on the same
    // merge to land at runCount 1 for its half of this sentence.
    const h = replace(
      ['alpha beta gamma delta stays here and epsilon zeta eta theta ends it'],
      ['one two three four stays here and five six seven eight ends it']
    )
    const runs = computeEditRuns(h)
    expect(runs).toHaveLength(2)
    expect(runs[0].delText).toBe('alpha beta gamma delta')
    expect(runs[0].addText).toBe('one two three four')
    expect(runs[1].delText).toBe('epsilon zeta eta theta')
    expect(runs[1].addText).toBe('five six seven eight')
    expectRunsRoundTrip(h, runs)
  })

  it('produces an insertion-only run when a replace hunk only adds words', () => {
    const h = replace(['keep this here'], ['keep this extra word here'])
    const runs = computeEditRuns(h)
    expect(runs).toHaveLength(1)
    expect(runs[0].delText).toBe('')
    expect(runs[0].addText).toBe('extra word ')
    // Zero-width on the baseline side, positioned where the text was inserted.
    expect(runs[0].baseStart).toBe(runs[0].baseEnd)
    expectRunsRoundTrip(h, runs)
  })

  it('produces a deletion-only run when a replace hunk only removes words', () => {
    const h = replace(['hello world foo'], ['hello foo'])
    const runs = computeEditRuns(h)
    expect(runs).toHaveLength(1)
    expect(runs[0].delText).toBe('world ')
    expect(runs[0].addText).toBe('')
    // Zero-width on the proposed side, positioned where the text was removed from.
    expect(runs[0].propStart).toBe(runs[0].propEnd)
    expectRunsRoundTrip(h, runs)
  })

  it('treats a whitespace-only change as one run with non-empty text on both sides', () => {
    const h = replace(['a  b'], ['a b'])
    const runs = computeEditRuns(h)
    expect(runs).toHaveLength(1)
    expect(runs[0].delText).toBe('  ')
    expect(runs[0].addText).toBe(' ')
    expectRunsRoundTrip(h, runs)
  })

  it('counts one run where labelMetrics counts two, when a changed part holds no word', () => {
    // KNOWN DIVERGENCE from labelMetrics, pinned deliberately. labelMetrics
    // increments runCount on a wordless changed part but leaves its `run`
    // accumulator at 0, so the next changed part increments a second time —
    // it reports 3 here for what is one whitespace cleanup plus one word swap.
    // computeEditRuns reports 2, which is what a decision list must offer.
    // Making this bug-compatible would put an undecidable unit in the UI, so
    // the label is the side that is wrong. US-004's R2 rule reclassifies the
    // whitespace run as syntax-only, leaving 1 decidable run + 1 disclosed
    // formatting change; the card's own "N words fixed" label stays overstated
    // until labelMetrics is fixed separately.
    const h = replace(['foo  bar baz'], ['foo bar qux'])
    const runs = computeEditRuns(h)
    expect(runs).toHaveLength(2)
    expect(runs[0].delText).toBe('  ')
    expect(runs[0].addText).toBe(' ')
    expect(runs[1].delText).toBe('baz')
    expect(runs[1].addText).toBe('qux')
    expectRunsRoundTrip(h, runs)
  })

  it('assigns ids as hunk id plus run index for multiple runs', () => {
    const h = replace(
      ['the priting industry is essentialy about publising'],
      ['the printing industry is essentially about publishing']
    )
    const runs = computeEditRuns(h)
    expect(runs.map((r) => r.id)).toEqual([`${h.id}:0`, `${h.id}:1`, `${h.id}:2`])
    expect(runs.map((r) => r.index)).toEqual([0, 1, 2])
  })

  it('round-trips offsets to source text across a spread of fixtures', () => {
    const fixtures = [
      replace(['the priting industry'], ['the printing industry']),
      replace(
        ['the priting industry is essentialy about publising'],
        ['the printing industry is essentially about publishing']
      ),
      replace(['keep this here'], ['keep this extra word here']),
      replace(['hello world foo'], ['hello foo']),
      replace(['a  b'], ['a b']),
      replace(['end here.'], ['end here!']),
      replace(
        ['alpha beta gamma delta stays here and epsilon zeta eta theta ends it'],
        ['one two three four stays here and five six seven eight ends it']
      ),
      replace(['first lien here', '', 'second lyne here'], ['first line here', '', 'second line here'])
    ]
    for (const h of fixtures) {
      expectRunsRoundTrip(h, computeEditRuns(h))
    }
  })
})
