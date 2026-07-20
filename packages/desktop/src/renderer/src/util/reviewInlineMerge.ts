import { computeMergedWordDiff, type DeletedRun } from 'common/diff/wordDiff'
import { wrapChangedSpans } from '@/util/reviewWordMarks'

/**
 * The inline merged view only works when both sides render to one flowing
 * paragraph; anything else (lists, code, multiple blocks) goes stacked.
 */
export const isSingleParagraph = (root: HTMLElement): boolean =>
  root.childElementCount === 1 && root.firstElementChild?.tagName === 'P'

const insertDeletedRun = (root: HTMLElement, run: DeletedRun): void => {
  const doc = root.ownerDocument
  const del = doc.createElement('del')
  del.className = 'review-word-del'
  del.textContent = run.text

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let remaining = run.offset
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const node = n as Text
    if (remaining <= node.data.length) {
      const target = remaining === 0 ? node : node.splitText(remaining)
      target.parentNode?.insertBefore(del, target)
      return
    }
    remaining -= node.data.length
  }
  // Offset at (or past) the very end: nothing follows to anchor against.
  ;(root.firstElementChild ?? root).appendChild(del)
}

/**
 * Word-style track changes: takes the rendered ADDED fragment, wraps inserted
 * runs with .review-word-add, and splices each deleted run in as a <del> at the
 * offset it was removed from.
 *
 * Deletions are inserted last-to-first because the tree walk counts every text
 * node it meets, including <del>s spliced by earlier iterations; going
 * front-to-back would shift each subsequent anchor by the length of the text
 * already inserted before it. Wrapping spans first is safe either way because
 * it never changes textContent.
 */
export const applyInlineMerge = (deletedText: string, addedRoot: HTMLElement): void => {
  const addedText = addedRoot.textContent ?? ''
  if (!deletedText || !addedText) {
    return
  }
  const { prop, deletions } = computeMergedWordDiff(deletedText, addedText)
  wrapChangedSpans(addedRoot, prop, 'review-word-add')
  for (let i = deletions.length - 1; i >= 0; i--) {
    insertDeletedRun(addedRoot, deletions[i])
  }
}
