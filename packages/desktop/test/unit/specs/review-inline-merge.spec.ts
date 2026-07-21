import { describe, expect, it } from 'vitest'
import type { DiffHunk } from 'common/diff'
import {
  applyInlineMerge,
  correlateRuns,
  isSingleParagraph,
  wrapDecidableRuns
} from '@/util/reviewInlineMerge'

const el = (html: string): HTMLElement => {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

const labels = { keep: 'Keep', undo: 'Undo', edit: 'Edit' }

let seq = 0
const hunk = (baselineLines: string[], proposedLines: string[]): DiffHunk => ({
  id: `wh${seq}`,
  index: 0,
  type: 'replace',
  baselineStart: 0,
  baselineLines,
  proposedStart: 0,
  proposedLines,
  contentKey: `wk${seq++}`
})

describe('applyInlineMerge', () => {
  // jsdiff does not attach trailing whitespace to a replaced word, so a struck
  // word and its replacement end up adjacent in the text stream ("pritingprinting").
  // That is the same adjacency Word's track changes produces; the two are told
  // apart by the .review-word-del / .review-word-add styling, not by a space.
  it('wraps inserted runs and splices deleted runs before them', () => {
    const added = el('<p>the printing industry</p>')
    applyInlineMerge('the priting industry', added)

    const dels = [...added.querySelectorAll('del.review-word-del')]
    const adds = [...added.querySelectorAll('.review-word-add')]
    expect(dels.map((d) => d.textContent)).toEqual(['priting'])
    expect(adds.map((a) => a.textContent)).toEqual(['printing'])
    // the deletion sits immediately before its replacement in document order
    expect(
      dels[0].compareDocumentPosition(adds[0]) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(added.textContent).toBe('the pritingprinting industry')
  })

  it('splices a pure deletion at its anchor even with no insertion beside it', () => {
    const added = el('<p>keep this here</p>')
    applyInlineMerge('keep this extra word here', added)

    expect(added.textContent).toBe('keep this extra word here')
    expect(added.querySelector('del.review-word-del')?.textContent).toBe('extra word ')
    expect(added.querySelectorAll('.review-word-add')).toHaveLength(0)
  })

  it('handles multiple runs, inserting later deletions without shifting earlier anchors', () => {
    const added = el('<p>aaa xxx ccc yyy eee</p>')
    applyInlineMerge('aaa bbb ccc ddd eee', added)

    expect([...added.querySelectorAll('del')].map((d) => d.textContent)).toEqual(['bbb', 'ddd'])
    expect(added.textContent).toBe('aaa bbbxxx ccc dddyyy eee')
  })

  it('preserves inline formatting of unchanged context', () => {
    const added = el('<p>fixed <em>emphasis</em> stays intact</p>')
    applyInlineMerge('fixxed emphasis stays intact', added)

    expect(added.querySelector('em')?.textContent).toBe('emphasis')
    expect(added.querySelector('del.review-word-del')?.textContent).toBe('fixxed')
  })

  it('splices a deletion that falls inside a formatted run without breaking the element', () => {
    const added = el('<p>keep <em>the new words</em> here</p>')
    applyInlineMerge('keep the old words here', added)

    expect(added.querySelector('em')).not.toBeNull()
    expect(added.querySelector('del.review-word-del')?.textContent).toBe('old')
    expect(added.textContent).toBe('keep the oldnew words here')
  })

  it('does nothing when either side is empty', () => {
    const added = el('<p>text</p>')
    applyInlineMerge('', added)
    expect(added.querySelectorAll('del')).toHaveLength(0)
    expect(added.textContent).toBe('text')
  })
})

describe('wrapDecidableRuns', () => {
  // Mirrors how reviewOverlay.vue calls it: correlate, THEN merge (merging
  // mutates addedEl's text, which is why deletedText/addedText are captured
  // beforehand), then wrap.
  const mergeAndWrap = (h: DiffHunk, deletedEl: HTMLElement, addedEl: HTMLElement) => {
    const correlation = correlateRuns(h, deletedEl, addedEl)
    const deletedText = deletedEl.textContent ?? ''
    const addedText = addedEl.textContent ?? ''
    applyInlineMerge(deletedText, addedEl)
    const wrapped = correlation
      ? wrapDecidableRuns(h.id, deletedText, addedText, addedEl, correlation.decidable, labels)
      : []
    return { correlation, wrapped }
  }

  it('wraps a single word-replace run in a focusable span carrying its popover', () => {
    const h = hunk(['the priting industry'], ['the printing industry'])
    const deletedEl = el('<p>the priting industry</p>')
    const addedEl = el('<p>the printing industry</p>')

    const { correlation, wrapped } = mergeAndWrap(h, deletedEl, addedEl)

    expect(wrapped).toEqual([0])
    const wrapper = addedEl.querySelector('.review-edit')
    expect(wrapper?.getAttribute('tabindex')).toBe('0')
    expect(wrapper?.getAttribute('data-run-key')).toBe(correlation?.decidable[0].id)
    expect(wrapper?.getAttribute('data-hunk-id')).toBe(h.id)
    expect(wrapper?.getAttribute('data-run-index')).toBe('0')
    expect(wrapper?.querySelector('del.review-word-del')?.textContent).toBe('priting')
    expect(wrapper?.querySelector('.review-word-add')?.textContent).toBe('printing')

    const buttons = [...(wrapper?.querySelectorAll('.review-edit-action') ?? [])]
    expect(buttons.map((b) => b.getAttribute('data-review-act'))).toEqual(['keep', 'undo', 'edit'])
    expect(buttons.map((b) => b.textContent)).toEqual(['Keep', 'Undo', 'Edit'])
    expect(buttons.every((b) => b.getAttribute('data-hunk-id') === h.id)).toBe(true)
    expect(buttons.every((b) => b.getAttribute('data-run-index') === '0')).toBe(true)
  })

  it('wraps each independent run of a multi-edit paragraph separately', () => {
    const h = hunk(
      ['the quick fox jumps over the lazy dog'],
      ['the slow fox leaps over the lazy dog']
    )
    const deletedEl = el('<p>the quick fox jumps over the lazy dog</p>')
    const addedEl = el('<p>the slow fox leaps over the lazy dog</p>')

    const { correlation, wrapped } = mergeAndWrap(h, deletedEl, addedEl)

    expect(correlation?.decidable).toHaveLength(2)
    expect(wrapped).toEqual([0, 1])
    const wrappers = [...addedEl.querySelectorAll('.review-edit')]
    expect(wrappers).toHaveLength(2)
    expect(wrappers.map((w) => w.querySelector('.review-word-add')?.textContent)).toEqual([
      'slow',
      'leaps'
    ])
    // Runs stay independent decision units: deciding one must not touch the
    // other's markup, which requires each to own a separate wrapper.
    expect(wrappers[0]).not.toBe(wrappers[1])
  })

  it('wraps a pure-deletion run at its anchor, with no added mark inside it', () => {
    const h = hunk(['keep this extra word here'], ['keep this here'])
    const deletedEl = el('<p>keep this extra word here</p>')
    const addedEl = el('<p>keep this here</p>')

    const { wrapped } = mergeAndWrap(h, deletedEl, addedEl)

    expect(wrapped).toEqual([0])
    const wrapper = addedEl.querySelector('.review-edit')
    expect(wrapper?.querySelector('del.review-word-del')?.textContent).toBe('extra word ')
    expect(wrapper?.querySelector('.review-word-add')).toBeNull()
  })

  it('wraps a pure-insertion run, with no deletion mark inside it', () => {
    const h = hunk(['keep this here'], ['keep this extra word here'])
    const deletedEl = el('<p>keep this here</p>')
    const addedEl = el('<p>keep this extra word here</p>')

    const { wrapped } = mergeAndWrap(h, deletedEl, addedEl)

    expect(wrapped).toEqual([0])
    const wrapper = addedEl.querySelector('.review-edit')
    expect(wrapper?.querySelector('del.review-word-del')).toBeNull()
    expect(wrapper?.querySelector('.review-word-add')?.textContent).toBe('extra word ')
  })

  it('produces no wrapper for an uncorrelated hunk (correlateRuns returned null)', () => {
    // Multi-paragraph fragments never correlate — the overlay's own
    // wantInline gate would also keep this out of the merged view entirely,
    // but this confirms wrapDecidableRuns is simply never reached for it.
    const h = hunk(['the priting industry'], ['the printing industry'])
    const deletedEl = el('<p>the priting</p><p>industry</p>')
    const addedEl = el('<p>the printing industry</p>')

    expect(correlateRuns(h, deletedEl, addedEl)).toBeNull()
    // No .review-edit exists anywhere because the component never calls
    // wrapDecidableRuns when correlation fails.
    expect(addedEl.querySelector('.review-edit')).toBeNull()
  })

  it('returns no wrappers and touches no DOM when decidable is empty', () => {
    const addedEl = el('<p>the printing industry</p>')
    const wrapped = wrapDecidableRuns(
      'h-empty',
      'the priting industry',
      'the printing industry',
      addedEl,
      [],
      labels
    )
    expect(wrapped).toEqual([])
    expect(addedEl.querySelector('.review-edit')).toBeNull()
  })
})

describe('isSingleParagraph', () => {
  it('accepts exactly one <p> and rejects everything else', () => {
    expect(isSingleParagraph(el('<p>one para</p>'))).toBe(true)
    expect(isSingleParagraph(el('<p>a</p><p>b</p>'))).toBe(false)
    expect(isSingleParagraph(el('<ul><li>item</li></ul>'))).toBe(false)
    expect(isSingleParagraph(el('<pre><code>code</code></pre>'))).toBe(false)
    expect(isSingleParagraph(el(''))).toBe(false)
  })
})
