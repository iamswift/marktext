import { diffWordsWithSpace } from 'diff'
import type { DiffHunk } from './index'

export type ReviewViewKind = 'inline' | 'stacked'

export interface HunkMetrics {
  /** Largest single contiguous edit: struck words + replacement words combined. */
  maxRunWords: number
  /** Number of separate contiguous edits in the hunk. */
  runCount: number
  linesBefore: number
  linesAfter: number
}

/**
 * Above this, a single edit is no longer a glanceable swap inside the
 * sentence — the reader is parsing two interleaved clauses. Chosen in the
 * mockup rule lab (tasks/mockups/review-ui-mockups.html): the corpus splits
 * cleanly at 2/2/2/2/4/7 words (all comfortable inline) vs 18/20/24/63
 * (all unreadable inline), and the per-hunk view toggle makes a wrong
 * default cheap, so the bar sits at the top of the comfortable band.
 */
export const INLINE_MAX_RUN_WORDS = 8

const wordCount = (text: string): number => {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

export function computeHunkMetrics(hunk: DiffHunk): HunkMetrics {
  const parts = diffWordsWithSpace(
    hunk.baselineLines.join('\n'),
    hunk.proposedLines.join('\n')
  )
  // Consecutive removed/added parts form one "run" — one interruption for an
  // inline reader, costed at both sides' word counts combined.
  let maxRunWords = 0
  let runCount = 0
  let currentRun = 0
  for (const part of parts) {
    if (part.added || part.removed) {
      if (currentRun === 0) {
        runCount++
      }
      currentRun += wordCount(part.value)
      if (currentRun > maxRunWords) {
        maxRunWords = currentRun
      }
    } else if (wordCount(part.value) > 1) {
      // Only a multi-word equal span marks a genuine boundary between separate
      // edits. Whitespace-only tokens and single-word LCS matches (e.g.
      // "approach" found in both sides of a large rewrite) are not enough
      // anchor text to split what the reader experiences as one interrupted
      // phrase — diffWordsWithSpace is too eager in finding single-word matches.
      currentRun = 0
    }
  }
  return {
    maxRunWords,
    runCount,
    linesBefore: hunk.baselineLines.length,
    linesAfter: hunk.proposedLines.length
  }
}

/**
 * Decide the default rendering for a hunk. Rule: "max run + structure",
 * selected via the mockup rule lab. Line count is deliberately NOT a size
 * signal — a two-paragraph hunk of one-word fixes must stay inline — it is
 * only a structure signal (split/merge cannot be shown in one paragraph).
 * The user can override per hunk (store) or globally (reviewDiffLayout).
 */
export function classifyHunk(hunk: DiffHunk): ReviewViewKind {
  if (hunk.type !== 'replace') {
    // add/delete hunks render as one tinted block; there is no pair to stack.
    return 'inline'
  }
  const metrics = computeHunkMetrics(hunk)
  if (metrics.linesBefore !== metrics.linesAfter) {
    return 'stacked'
  }
  if (metrics.maxRunWords > INLINE_MAX_RUN_WORDS) {
    return 'stacked'
  }
  return 'inline'
}
