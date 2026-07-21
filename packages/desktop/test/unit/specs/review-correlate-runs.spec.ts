import { describe, expect, it } from 'vitest'
import type { DiffHunk } from 'common/diff'
import { correlateRuns } from '@/util/reviewInlineMerge'

let seq = 0
const hunk = (baselineLines: string[], proposedLines: string[]): DiffHunk => ({
  id: `h${seq}`,
  index: 0,
  type: 'replace',
  baselineStart: 0,
  baselineLines,
  proposedStart: 0,
  proposedLines,
  // Unique per construction so nothing accidentally keys off a shared fingerprint.
  contentKey: `k${seq++}`
})

const addHunk = (proposedLines: string[]): DiffHunk => ({
  id: `h${seq}`,
  index: 0,
  type: 'add',
  baselineStart: 0,
  baselineLines: [],
  proposedStart: 0,
  proposedLines,
  contentKey: `k${seq++}`
})

const el = (html: string): HTMLElement => {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

describe('correlateRuns', () => {
  it('does not veto the hunk on a syntax-only run beside a real typo fix', () => {
    // **bold** -> _bold_ is a pure formatting swap; "teh" -> "the" is a real
    // content fix. The formatting run must be filed as syntaxOnly, not cause
    // the whole hunk to fall back to null (R2 before R3).
    const h = hunk(['this is **bold** and teh text'], ['this is _bold_ and the text'])
    const deletedRoot = el('<p>this is bold and teh text</p>')
    const addedRoot = el('<p>this is bold and the text</p>')

    const result = correlateRuns(h, deletedRoot, addedRoot)

    expect(result).not.toBeNull()
    expect(result?.decidable).toHaveLength(1)
    expect(result?.syntaxOnly).toHaveLength(1)
    expect(result?.decidable[0].delText).toBe('teh')
    expect(result?.decidable[0].addText).toBe('the')
    expect(result?.syntaxOnly[0].delText).toBe('**bold**')
    expect(result?.syntaxOnly[0].addText).toBe('_bold_')
  })

  it('returns null when a genuinely unalignable content run cannot be correlated', () => {
    // The rendered text diverges from the source diff in a way alignRuns
    // cannot reconcile (rendered text bears no relation to the source
    // change), so R3 must veto the whole hunk.
    const h = hunk(['the priting industry'], ['the printing industry'])
    const deletedRoot = el('<p>completely unrelated content here</p>')
    const addedRoot = el('<p>totally different rendered text</p>')

    const result = correlateRuns(h, deletedRoot, addedRoot)

    expect(result).toBeNull()
  })

  it('returns null for a non-replace hunk', () => {
    const h = addHunk(['a brand new paragraph'])
    const deletedRoot = el('<p></p>')
    const addedRoot = el('<p>a brand new paragraph</p>')

    expect(correlateRuns(h, deletedRoot, addedRoot)).toBeNull()
  })

  it('returns null when the deleted fragment is not a single paragraph', () => {
    const h = hunk(['the priting industry'], ['the printing industry'])
    const deletedRoot = el('<p>the priting</p><p>industry</p>')
    const addedRoot = el('<p>the printing industry</p>')

    expect(correlateRuns(h, deletedRoot, addedRoot)).toBeNull()
  })

  it('returns null when the added fragment is not a single paragraph', () => {
    const h = hunk(['the priting industry'], ['the printing industry'])
    const deletedRoot = el('<p>the priting industry</p>')
    const addedRoot = el('<ul><li>the printing industry</li></ul>')

    expect(correlateRuns(h, deletedRoot, addedRoot)).toBeNull()
  })

  it('returns all runs as decidable with zero syntaxOnly for a clean multi-typo paragraph', () => {
    const h = hunk(
      ['the priting industry is essentialy about publising'],
      ['the printing industry is essentially about publishing']
    )
    const deletedRoot = el('<p>the priting industry is essentialy about publising</p>')
    const addedRoot = el('<p>the printing industry is essentially about publishing</p>')

    const result = correlateRuns(h, deletedRoot, addedRoot)

    expect(result).not.toBeNull()
    expect(result?.decidable).toHaveLength(3)
    expect(result?.syntaxOnly).toHaveLength(0)
  })

  it('returns null when every run is syntax-only, so the hunk still gets a decision', () => {
    // Nothing here is decidable change-by-change, but the reviewer must still
    // be able to reject the reformatting. A correlation with an empty
    // decidable set would seed the hunk fully decided and slip it past them.
    const h = hunk(['this is **bold** text'], ['this is _bold_ text'])
    const deletedRoot = el('<p>this is bold text</p>')
    const addedRoot = el('<p>this is bold text</p>')

    expect(correlateRuns(h, deletedRoot, addedRoot)).toBeNull()
  })

  it('returns source runs (not rendered runs) whose offsets slice correctly out of the hunk source text', () => {
    const h = hunk(['this is **bold** and teh text'], ['this is _bold_ and the text'])
    const deletedRoot = el('<p>this is bold and teh text</p>')
    const addedRoot = el('<p>this is bold and the text</p>')

    const result = correlateRuns(h, deletedRoot, addedRoot)

    expect(result).not.toBeNull()
    const baselineText = h.baselineLines.join('\n')
    const proposedText = h.proposedLines.join('\n')
    for (const run of [...(result?.decidable ?? []), ...(result?.syntaxOnly ?? [])]) {
      expect(baselineText.slice(run.baseStart, run.baseEnd)).toBe(run.delText)
      expect(proposedText.slice(run.propStart, run.propEnd)).toBe(run.addText)
    }
  })
})
