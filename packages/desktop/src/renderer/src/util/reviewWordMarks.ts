import { computeLineWordDiff, type WordSpan } from 'common/diff/wordDiff'

/**
 * Wraps every changed character range in <span class="…"> elements. The spans
 * must concatenate to exactly root.textContent (they are computed from it), so
 * the walk consumes both streams in lockstep; ranges crossing text-node
 * boundaries are wrapped piecewise per node.
 */
export const wrapChangedSpans = (
  root: HTMLElement,
  spans: readonly WordSpan[],
  className: string
): void => {
  const doc = root.ownerDocument
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if ((n as Text).data.length > 0) {
      textNodes.push(n as Text)
    }
  }

  let spanIndex = 0
  let spanOffset = 0

  for (const collected of textNodes) {
    let node: Text = collected
    while (node.data.length > 0 && spanIndex < spans.length) {
      const span = spans[spanIndex]
      const take = Math.min(span.text.length - spanOffset, node.data.length)
      const rest = node.data.length > take ? node.splitText(take) : null

      if (span.changed) {
        const wrapper = doc.createElement('span')
        wrapper.className = className
        node.parentNode?.insertBefore(wrapper, node)
        wrapper.appendChild(node)
      }

      spanOffset += take
      if (spanOffset >= span.text.length) {
        spanIndex++
        spanOffset = 0
      }
      if (!rest) {
        break
      }
      node = rest
    }
  }
}

/**
 * Word-level diff highlighting for a replace hunk's rendered fragments. The
 * diff runs on the RENDERED text of both sides (not the markdown source), so
 * the spans always match the DOM text stream regardless of inline formatting.
 */
export const applyWordMarks = (deletedRoot: HTMLElement, addedRoot: HTMLElement): void => {
  const deletedText = deletedRoot.textContent ?? ''
  const addedText = addedRoot.textContent ?? ''
  if (!deletedText || !addedText) {
    return
  }
  const { base, prop } = computeLineWordDiff(deletedText, addedText)
  wrapChangedSpans(deletedRoot, base, 'review-word-del')
  wrapChangedSpans(addedRoot, prop, 'review-word-add')
}
