import { computeMergedWordDiff, type DeletedRun } from 'common/diff/wordDiff'
import type { DiffHunk } from 'common/diff'
import {
  alignRuns,
  computeEditRuns,
  computeTextRuns,
  normalizeRunText,
  type EditRun
} from 'common/diff/editRuns'
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

/** The two source-run buckets `correlateRuns` sorts a hunk's changes into. */
export interface RunCorrelation {
  /** Source runs cleared for a per-change Keep/Undo decision. */
  decidable: EditRun[]
  /** Source runs that changed markdown syntax only (R2) — disclosed but not decided on. */
  syntaxOnly: EditRun[]
}

/**
 * Decides whether a hunk can safely offer per-change decisions instead of a
 * single hunk-level Keep/Undo. Review rendering diffs DOM text; a decision
 * must resolve to markdown SOURCE offsets for write-back, so this is the
 * guard that keeps those two coordinate systems from silently drifting apart.
 * Any doubt resolves to `null`, and the caller falls back to today's
 * hunk-level behavior — never a partial or wrong-offset decision.
 *
 * Callers must independently confirm `reviewStore.viewFor(hunk.id) ===
 * 'inline'` before calling this: view selection is presentation policy that
 * belongs in the store, and this util stays pure (no Pinia import) so it can
 * be unit-tested without store setup.
 */
export const correlateRuns = (
  hunk: DiffHunk,
  deletedRoot: HTMLElement,
  addedRoot: HTMLElement
): RunCorrelation | null => {
  if (hunk.type !== 'replace') {
    return null
  }
  if (!isSingleParagraph(deletedRoot) || !isSingleParagraph(addedRoot)) {
    return null
  }

  const sourceRuns = computeEditRuns(hunk)
  const renderedRuns = computeTextRuns(
    hunk.id,
    deletedRoot.textContent ?? '',
    addedRoot.textContent ?? ''
  )

  // R2: a run whose normalized text is unchanged only rewrote markdown syntax
  // (e.g. **bold** -> _bold_). It is not a decision unit — accepting or
  // undoing "formatting" independent of content makes no sense to a reviewer
  // — and it typically has no rendered counterpart at all, since the visible
  // text is identical on both sides. It must be pulled out BEFORE alignment
  // so it never reaches R3 and vetoes the hunk over a change nobody can see.
  const contentRuns: EditRun[] = []
  const syntaxOnly: EditRun[] = []
  for (const run of sourceRuns) {
    if (normalizeRunText(run.delText) === normalizeRunText(run.addText)) {
      syntaxOnly.push(run)
    } else {
      contentRuns.push(run)
    }
  }

  const alignment = alignRuns(contentRuns, renderedRuns)

  // R3: veto the whole hunk if ANY content run can't be correlated to a
  // rendered run, rather than dropping just that run. Offering decisions on
  // some changes in a paragraph while silently omitting others is worse than
  // the existing hunk-level fallback — a reviewer who accepts what's shown
  // would not know an undecided change still lurks in the hunk. All-or-nothing
  // keeps that failure mode impossible.
  if (alignment.some((index) => index === null)) {
    return null
  }

  // A hunk with nothing decidable is not "already decided" — it is a hunk the
  // reviewer still has to rule on, just not change-by-change. Returning a
  // correlation here would let a formatting-only paragraph seed itself fully
  // accepted (US-007 treats every decidable run being settled as a decided
  // hunk) and disappear without ever being shown. Fall back to hunk-level.
  if (contentRuns.length === 0) {
    return null
  }

  return { decidable: contentRuns, syntaxOnly }
}
