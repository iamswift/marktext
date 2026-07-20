import { describe, expect, it } from 'vitest'
import { applyWordMarks, wrapChangedSpans } from '@/util/reviewWordMarks'

const el = (html: string): HTMLElement => {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

describe('wrapChangedSpans', () => {
  it('wraps a changed range inside a single text node', () => {
    const root = el('<p>the quick fox</p>')
    wrapChangedSpans(
      root,
      [
        { text: 'the ', changed: false },
        { text: 'quick', changed: true },
        { text: ' fox', changed: false }
      ],
      'mark'
    )
    expect(root.querySelectorAll('span.mark')).toHaveLength(1)
    expect(root.querySelector('span.mark')?.textContent).toBe('quick')
    expect(root.textContent).toBe('the quick fox')
  })

  it('wraps ranges crossing element boundaries piecewise', () => {
    const root = el('<p>ab <strong>cd</strong> ef</p>')
    // Rendered text is 'ab cd ef'; mark 'b cd e' (crosses into and out of <strong>).
    wrapChangedSpans(
      root,
      [
        { text: 'a', changed: false },
        { text: 'b cd e', changed: true },
        { text: 'f', changed: false }
      ],
      'mark'
    )
    const marks = [...root.querySelectorAll('span.mark')]
    expect(marks.length).toBe(3)
    expect(marks.map((m) => m.textContent).join('')).toBe('b cd e')
    expect(root.textContent).toBe('ab cd ef')
    // The strong formatting must survive intact.
    expect(root.querySelector('strong')?.textContent).toBe('cd')
  })

  it('does nothing when no span is changed', () => {
    const root = el('<p>same text</p>')
    wrapChangedSpans(root, [{ text: 'same text', changed: false }], 'mark')
    expect(root.querySelectorAll('span.mark')).toHaveLength(0)
    expect(root.innerHTML).toBe('<p>same text</p>')
  })

  it('stops silently when spans undershoot the text', () => {
    const root = el('<p>longer than spans</p>')
    wrapChangedSpans(root, [{ text: 'longer', changed: true }], 'mark')
    expect(root.querySelector('span.mark')?.textContent).toBe('longer')
    expect(root.textContent).toBe('longer than spans')
  })
})

describe('applyWordMarks', () => {
  it('marks only the words that differ between the rendered sides', () => {
    const deleted = el('<p>the <em>quick</em> brown fox</p>')
    const added = el('<p>the <em>slow</em> brown fox</p>')
    applyWordMarks(deleted, added)

    const delMarks = [...deleted.querySelectorAll('.review-word-del')]
    const addMarks = [...added.querySelectorAll('.review-word-add')]
    expect(delMarks.map((m) => m.textContent).join('')).toBe('quick')
    expect(addMarks.map((m) => m.textContent).join('')).toBe('slow')
    expect(deleted.textContent).toBe('the quick brown fox')
    expect(added.textContent).toBe('the slow brown fox')
  })

  it('leaves both sides unmarked when one side has no text', () => {
    const deleted = el('')
    const added = el('<p>new paragraph</p>')
    applyWordMarks(deleted, added)
    expect(added.querySelectorAll('.review-word-add')).toHaveLength(0)
  })
})
