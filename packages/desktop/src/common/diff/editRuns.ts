import { diffWordsWithSpace } from 'diff'
import type { DiffHunk } from './index'

/**
 * One decidable unit of a review card, expressed in markdown SOURCE offsets
 * rather than rendered DOM text — a decision resolves to source so it can be
 * written back to disk. `baseStart`/`baseEnd` index into
 * `hunk.baselineLines.join('\n')`; `propStart`/`propEnd` index into
 * `hunk.proposedLines.join('\n')`. Either text side may be empty (an
 * insertion- or deletion-only run), in which case its two offsets are equal.
 */
export interface EditRun {
  index: number
  id: string
  delText: string
  addText: string
  baseStart: number
  baseEnd: number
  propStart: number
  propEnd: number
}

const wordCount = (text: string): number => {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

/**
 * Splits a hunk's word diff into edit runs, one per {@link EditRun}. Run
 * boundaries follow `labelMetrics` in summarize.ts, NOT `computeHunkMetrics`
 * in classify.ts: those two deliberately disagree. classify.ts keeps a run
 * alive across a single shared word so an incidental LCS match mid-rewrite
 * doesn't split one interrupted phrase into two; that reads right for
 * choosing inline-vs-stacked layout but would silently merge unrelated
 * word-swaps here. A decision list needs the opposite — one run per
 * independently acceptable edit — so a run only survives an equal part that
 * carries no real word (whitespace), and resets on any equal part that does.
 * This keeps run COUNT identical to the margin card's label.
 *
 * A whitespace-only equal part inside an open run is folded into both
 * `delText` and `addText` (and both offset ranges) rather than dropped: it is
 * literally present, unchanged, in both source texts at that position, so
 * omitting it would break the `text.slice(start, end) === run text`
 * invariant callers rely on for write-back.
 */
export const computeEditRuns = (hunk: DiffHunk): EditRun[] => {
  if (hunk.type !== 'replace') {
    return []
  }

  const baselineText = hunk.baselineLines.join('\n')
  const proposedText = hunk.proposedLines.join('\n')
  if (baselineText === proposedText) {
    return []
  }

  const parts = diffWordsWithSpace(baselineText, proposedText)

  const runs: EditRun[] = []
  let baseOffset = 0
  let propOffset = 0

  let inRun = false
  let runBaseStart = 0
  let runPropStart = 0
  let delText = ''
  let addText = ''

  const flush = (baseEnd: number, propEnd: number): void => {
    if (!inRun) {
      return
    }
    runs.push({
      index: runs.length,
      id: `${hunk.id}:${runs.length}`,
      delText,
      addText,
      baseStart: runBaseStart,
      baseEnd,
      propStart: runPropStart,
      propEnd
    })
    inRun = false
    delText = ''
    addText = ''
  }

  for (const part of parts) {
    if (part.added || part.removed) {
      if (!inRun) {
        inRun = true
        runBaseStart = baseOffset
        runPropStart = propOffset
      }
      if (part.removed) {
        delText += part.value
      }
      if (part.added) {
        addText += part.value
      }
    } else if (wordCount(part.value) > 0) {
      flush(baseOffset, propOffset)
    } else if (inRun) {
      delText += part.value
      addText += part.value
    }

    if (!part.added) {
      baseOffset += part.value.length
    }
    if (!part.removed) {
      propOffset += part.value.length
    }
  }
  flush(baseOffset, propOffset)

  return runs
}
