import { describe, expect, it } from 'vitest'
import { applyInlineMerge, isSingleParagraph } from '@/util/reviewInlineMerge'

const el = (html: string): HTMLElement => {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

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

describe('isSingleParagraph', () => {
  it('accepts exactly one <p> and rejects everything else', () => {
    expect(isSingleParagraph(el('<p>one para</p>'))).toBe(true)
    expect(isSingleParagraph(el('<p>a</p><p>b</p>'))).toBe(false)
    expect(isSingleParagraph(el('<ul><li>item</li></ul>'))).toBe(false)
    expect(isSingleParagraph(el('<pre><code>code</code></pre>'))).toBe(false)
    expect(isSingleParagraph(el(''))).toBe(false)
  })
})
