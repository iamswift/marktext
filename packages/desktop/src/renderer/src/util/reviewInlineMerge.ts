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

/**
 * Labels for a decidable run's popover and for a settled run's accessible
 * name/tooltip; supplied by the caller (i18n lives in the Vue layer) so this
 * module can stay Pinia/i18n-free and unit-testable in isolation.
 */
export interface RunActionLabels {
  keep: string
  undo: string
  edit: string
  /** aria-label/title for a run settled as accepted (US-009). */
  kept: string
  /** aria-label/title for a run settled as rejected (US-009). */
  undone: string
  /**
   * aria-label for a still-pending run (US-013) — states the old and new
   * text so a keyboard/screen-reader user can identify the change without
   * relying on the struck-through/underlined visual marks alone. Left empty
   * to a caller for whichever side a pure insertion/deletion has none of.
   */
  describeChange: (oldText: string, newText: string) => string
}

/**
 * One point in `addedRoot`'s document-order walk, positioned in the same
 * offset space as `EditRun.propStart/propEnd` (the proposed text before
 * applyInlineMerge spliced anything in). A text node occupies a range at its
 * offset; a spliced `<del>` occupies none — insertDeletedRun anchors it
 * against the offset that precedes it, so it is recorded as a zero-width
 * point rather than descended into.
 */
interface OffsetEntry {
  offset: number
  textNode?: Text
  delElement?: HTMLElement
}

const collectOffsetEntries = (root: HTMLElement): OffsetEntry[] => {
  const entries: OffsetEntry[] = []
  let cursor = 0

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node as Text
      entries.push({ offset: cursor, textNode: text })
      cursor += text.data.length
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return
    }
    const element = node as HTMLElement
    if (element.tagName === 'DEL' && element.classList.contains('review-word-del')) {
      entries.push({ offset: cursor, delElement: element })
      return
    }
    for (const child of Array.from(element.childNodes)) {
      walk(child)
    }
  }

  for (const child of Array.from(root.childNodes)) {
    walk(child)
  }
  return entries
}

/**
 * A boundary offset that falls exactly between two adjacent text nodes
 * matches both: the end of the earlier one and the start of the later one.
 * The end-of-node form is the wrong pick whenever that earlier node is the
 * sole child of a mark wrapper (e.g. `.review-word-add`) — `Range.
 * extractContents()` ranks an element's "after last child" boundary as
 * strictly AFTER its last child's own end-of-data offset (a DOM
 * boundary-point-comparison quirk, not a bug in extractContents), so the
 * wrapper reads as only partially contained. It then clones the wrapper into
 * the extracted fragment while leaving the ORIGINAL wrapper's text emptied
 * in place — a hollow `<span class="review-word-add"></span>` surviving in
 * the live DOM after a decision. Preferring the start-of-next-node form
 * (nodeOffset 0) sidesteps this: that boundary sits unambiguously outside
 * the earlier node's wrapper, so extractContents sees it as fully contained
 * and moves it wholesale instead of splitting it.
 */
const findTextBoundary = (
  entries: readonly OffsetEntry[],
  offset: number
): { node: Text; nodeOffset: number } | null => {
  let fallback: { node: Text; nodeOffset: number } | null = null
  for (const entry of entries) {
    if (!entry.textNode) {
      continue
    }
    const length = entry.textNode.data.length
    if (offset < entry.offset || offset > entry.offset + length) {
      continue
    }
    const nodeOffset = offset - entry.offset
    if (nodeOffset === 0) {
      return { node: entry.textNode, nodeOffset }
    }
    if (!fallback) {
      fallback = { node: entry.textNode, nodeOffset }
    }
  }
  return fallback
}

const findDelAt = (entries: readonly OffsetEntry[], offset: number): HTMLElement | null =>
  entries.find((entry) => entry.delElement !== undefined && entry.offset === offset)
    ?.delElement ?? null

const buildPopover = (
  doc: Document,
  hunkId: string,
  runIndex: number,
  labels: RunActionLabels
): HTMLElement => {
  const popover = doc.createElement('span')
  popover.className = 'review-edit-popover'
  popover.setAttribute('role', 'menu')

  const addAction = (act: 'keep' | 'undo' | 'edit', label: string): void => {
    const button = doc.createElement('button')
    button.type = 'button'
    button.className = `review-edit-action ${act}`
    button.dataset.hunkId = hunkId
    button.dataset.runIndex = String(runIndex)
    button.dataset.reviewAct = act
    button.title = label
    button.textContent = label
    popover.appendChild(button)
  }

  addAction('keep', labels.keep)
  addAction('undo', labels.undo)
  addAction('edit', labels.edit)

  return popover
}

/**
 * Wraps one decidable run's del+add mark pair — already spliced into
 * `addedRoot` by applyInlineMerge — in a focusable `.review-edit` span
 * carrying its popover. `renderedRun` supplies the offsets (in
 * applyInlineMerge's pre-splice text space) and `sourceRun` supplies the
 * write-back index/id the popover's buttons act on.
 *
 * Extracts the range and re-inserts it inside a new wrapper, rather than
 * Range.surroundContents: surroundContents throws whenever the range's start
 * and end boundaries sit at different nesting depths (e.g. the deletion
 * marker sits as a direct child of the run's block while the addition mark
 * one level deeper, inside .review-word-add) — the DOM spec calls that a
 * "partially contained" non-Text node, and this shape hits it on nearly
 * every real replace run, not just an edge case. extractContents() performs
 * the same character-offset split without that restriction (it clones/closes
 * partially-spanned ancestors as needed); insertNode() puts the collapsed
 * range's boundary — and so the wrapper — back where the extracted content
 * used to be.
 *
 * `decision` is undefined for a still-pending run, which renders exactly as
 * before (both marks, a Keep/Undo/Edit popover). When a decision is present
 * (US-009), the extracted del+add markup is discarded outright rather than
 * hidden — the wrapper is refilled with a single plain-text node holding
 * only the winning side (`renderedRun.addText` for 'accept',
 * `renderedRun.delText` for 'reject'), so a screen reader's textContent read
 * and a sighted skim both see settled prose, never the losing side or its
 * tint.
 * The popover is dropped too: a settled run's only affordance is the
 * wrapper itself, which the overlay's click handler routes to revertRun.
 */
const wrapOneRun = (
  addedRoot: HTMLElement,
  entries: readonly OffsetEntry[],
  hunkId: string,
  sourceRun: EditRun,
  renderedRun: EditRun,
  labels: RunActionLabels,
  decision?: 'accept' | 'reject'
): void => {
  const doc = addedRoot.ownerDocument
  const hasDeletion = renderedRun.delText !== ''
  const hasAddition = renderedRun.addText !== ''
  if (!hasDeletion && !hasAddition) {
    throw new Error('run has neither deletion nor addition')
  }

  const range = doc.createRange()

  if (hasDeletion) {
    const delElement = findDelAt(entries, renderedRun.propStart)
    if (!delElement) {
      throw new Error('deleted run marker not found at expected offset')
    }
    range.setStartBefore(delElement)
    if (hasAddition) {
      const end = findTextBoundary(entries, renderedRun.propEnd)
      if (!end) {
        throw new Error('end boundary not found')
      }
      range.setEnd(end.node, end.nodeOffset)
    } else {
      range.setEndAfter(delElement)
    }
  } else {
    const start = findTextBoundary(entries, renderedRun.propStart)
    const end = findTextBoundary(entries, renderedRun.propEnd)
    if (!start || !end) {
      throw new Error('start/end boundary not found')
    }
    range.setStart(start.node, start.nodeOffset)
    range.setEnd(end.node, end.nodeOffset)
  }

  const wrapper = doc.createElement('span')
  wrapper.tabIndex = 0
  wrapper.dataset.runKey = sourceRun.id
  wrapper.dataset.hunkId = hunkId
  wrapper.dataset.runIndex = String(sourceRun.index)

  const extracted = range.extractContents()

  if (decision) {
    wrapper.className = 'review-edit review-edit-settled'
    wrapper.dataset.reviewDecision = decision
    // role="button": the wrapper itself is the only affordance here (no
    // popover), so it must read as actionable, not as a plain text run.
    wrapper.setAttribute('role', 'button')
    const settledText = decision === 'accept' ? renderedRun.addText : renderedRun.delText
    if (settledText !== '') {
      wrapper.appendChild(doc.createTextNode(settledText))
    }
    const label = decision === 'accept' ? labels.kept : labels.undone
    wrapper.setAttribute('aria-label', label)
    wrapper.title = label
    range.insertNode(wrapper)
  } else {
    wrapper.className = 'review-edit'
    wrapper.appendChild(extracted)
    range.insertNode(wrapper)
    wrapper.appendChild(buildPopover(doc, hunkId, sourceRun.index, labels))
    // Names the change itself (US-013) — separate from the popover buttons'
    // own titles, which name the ACTIONS, not what they'd act on.
    wrapper.setAttribute('aria-label', labels.describeChange(renderedRun.delText, renderedRun.addText))
  }
}

/**
 * After applyInlineMerge has spliced its <del>/.review-word-add marks into
 * `addedRoot`, wraps each of `decidable`'s del+add pairs in a focusable
 * `.review-edit` span so the overlay can offer a per-change Keep/Undo/Edit
 * popover on it. Returns the subset of `decidable`'s indexes that actually
 * got a wrapper — the caller should only tell the store those are
 * per-change decidable; a run skipped here (see wrapOneRun) has no UI to
 * decide it individually and must fall back to the hunk's whole-hunk
 * Keep/Undo.
 *
 * Re-derives the rendered runs and realigns `decidable` against them rather
 * than reusing correlateRuns's (pre-splice) alignment, because
 * applyInlineMerge has since mutated addedRoot's text — `deletedText`/
 * `addedText` must be the strings captured BEFORE that call for the offsets
 * to still land correctly.
 *
 * `runDecisions` (US-009) is keyed by the SOURCE run's index — the same
 * coordinate space as `decidable`'s entries and reviewStore.runDecisions —
 * so a settled run collapses regardless of how its rendered counterpart's
 * offsets shifted this render.
 */
export const wrapDecidableRuns = (
  hunkId: string,
  deletedText: string,
  addedText: string,
  addedRoot: HTMLElement,
  decidable: readonly EditRun[],
  labels: RunActionLabels,
  runDecisions?: ReadonlyMap<number, 'accept' | 'reject'>
): number[] => {
  if (decidable.length === 0 || !deletedText || !addedText) {
    return []
  }

  const renderedRuns = computeTextRuns(hunkId, deletedText, addedText)
  const alignment = alignRuns(decidable, renderedRuns)
  const entries = collectOffsetEntries(addedRoot)

  const wrapped: number[] = []
  decidable.forEach((run, i) => {
    const renderedIndex = alignment[i]
    if (renderedIndex === null) {
      return
    }
    try {
      wrapOneRun(
        addedRoot,
        entries,
        hunkId,
        run,
        renderedRuns[renderedIndex],
        labels,
        runDecisions?.get(run.index)
      )
      wrapped.push(run.index)
    } catch {
      // Best-effort — see wrapOneRun's doc comment. The run stays part of
      // the merged paragraph, undecidable on its own this render.
    }
  })

  return wrapped
}
