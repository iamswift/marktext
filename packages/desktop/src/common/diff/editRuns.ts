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
 * Splits a pair of plain-text strings into edit runs, one per {@link EditRun}.
 * Run boundaries follow `labelMetrics` in summarize.ts, NOT
 * `computeHunkMetrics` in classify.ts: those two deliberately disagree.
 * classify.ts keeps a run alive across a single shared word so an incidental
 * LCS match mid-rewrite doesn't split one interrupted phrase into two; that
 * reads right for choosing inline-vs-stacked layout but would silently merge
 * unrelated word-swaps here. A decision list needs the opposite — one run per
 * independently acceptable edit — so a run only survives an equal part that
 * carries no real word (whitespace), and resets on any equal part that does.
 * This keeps run COUNT identical to the margin card's label.
 *
 * A whitespace-only equal part inside an open run is folded into both
 * `delText` and `addText` (and both offset ranges) rather than dropped: it is
 * literally present, unchanged, in both source texts at that position, so
 * omitting it would break the `text.slice(start, end) === run text`
 * invariant callers rely on for write-back.
 *
 * Shared by `computeEditRuns` (source lines) and review correlation (rendered
 * DOM text) so both coordinate systems split runs identically — if they used
 * different splitting rules, alignment between them would fail for reasons
 * unrelated to the document itself.
 */
export const computeTextRuns = (id: string, baseText: string, propText: string): EditRun[] => {
  if (baseText === propText) {
    return []
  }

  const parts = diffWordsWithSpace(baseText, propText)

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
      id: `${id}:${runs.length}`,
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

/**
 * Splits a hunk's word diff into edit runs. Delegates to {@link
 * computeTextRuns} against the hunk's joined source lines — see that
 * function's doc comment for the run-splitting rules.
 */
export const computeEditRuns = (hunk: DiffHunk): EditRun[] => {
  if (hunk.type !== 'replace') {
    return []
  }

  return computeTextRuns(hunk.id, hunk.baselineLines.join('\n'), hunk.proposedLines.join('\n'))
}

/**
 * Normalizes run text for cross-coordinate-system comparison. A decision is
 * anchored to a source run (markdown), but review UI selection happens on a
 * rendered run (DOM text) — `**bold**` in source vs. `bold` on screen — so
 * alignment can't compare raw text. Marker-stripping runs before whitespace
 * collapse: removing `**`/`_`/`` ` `` can leave behind a doubled space (e.g.
 * `*a* *b*` -> `a  b`), which the collapse pass then needs to fold.
 */
export const normalizeRunText = (text: string): string =>
  text
    .normalize('NFC')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Correlates source runs (write-back coordinates) to rendered runs (what the
 * reviewer selected on screen) by normalized text equality. Matching is
 * greedy and sequential: for each source run, the earliest not-yet-consumed
 * rendered run whose normalized delText and addText both match is taken.
 *
 * R1: when a source run has no match, it must NOT consume a rendered run or
 * advance past any — the next source run has to remain free to match the
 * same rendered run the failed one would have taken. Without this, one
 * unmatchable run silently vetoes the alignment of every run after it.
 *
 * Matches are also monotonic: the search floor only ever moves forward, so
 * two runs whose normalized text is identical can never cross and bind a
 * decision to the wrong position on screen. Both sequences describe the same
 * paragraph in document order, so a legitimate match is never behind the
 * floor and monotonicity costs no correlation rate.
 */
export const alignRuns = (
  sourceRuns: readonly EditRun[],
  renderedRuns: readonly EditRun[]
): Array<number | null> => {
  let floor = 0

  return sourceRuns.map((sourceRun) => {
    const normDel = normalizeRunText(sourceRun.delText)
    const normAdd = normalizeRunText(sourceRun.addText)

    for (let i = floor; i < renderedRuns.length; i++) {
      const candidate = renderedRuns[i]
      if (
        normalizeRunText(candidate.delText) === normDel &&
        normalizeRunText(candidate.addText) === normAdd
      ) {
        floor = i + 1
        return i
      }
    }

    return null
  })
}
