import { diffArrays } from 'diff'

export type DiffHunkType = 'add' | 'delete' | 'replace'

export interface DiffHunk {
  id: string
  index: number
  type: DiffHunkType
  /** 0-based line index into the baseline; for 'add' hunks, the insertion point. */
  baselineStart: number
  /** Baseline lines this hunk removes; empty for 'add'. */
  baselineLines: string[]
  proposedStart: number
  /** Proposed lines this hunk inserts; empty for 'delete'. */
  proposedLines: string[]
  /** Content fingerprint used to re-apply decisions after a mid-review restart. */
  contentKey: string
}

/** Strips a leading BOM and converts CRLF/CR to LF so diffs never see EOL noise. */
export const normalizeText = (text: string): string => {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return withoutBom.replace(/\r\n?/g, '\n')
}

const hashText = (text: string): string => {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

export const makeContentKey = (
  baselineLines: readonly string[],
  proposedLines: readonly string[]
): string => `${hashText(baselineLines.join('\n'))}:${hashText(proposedLines.join('\n'))}`

export function computeHunks(baseline: string, proposed: string): DiffHunk[] {
  const normBaseline = normalizeText(baseline)
  const normProposed = normalizeText(proposed)
  if (normBaseline === normProposed) {
    return []
  }

  const baselineLines = normBaseline.split('\n')
  const proposedLines = normProposed.split('\n')
  const parts = diffArrays(baselineLines, proposedLines)

  const hunks: DiffHunk[] = []
  let baselineCursor = 0
  let proposedCursor = 0
  let i = 0

  while (i < parts.length) {
    while (i < parts.length && !parts[i].added && !parts[i].removed) {
      baselineCursor += parts[i].value.length
      proposedCursor += parts[i].value.length
      i++
    }
    if (i >= parts.length) {
      break
    }

    const runBaselineStart = baselineCursor
    const runProposedStart = proposedCursor
    const runBaselineLines: string[] = []
    const runProposedLines: string[] = []

    while (i < parts.length && (parts[i].added || parts[i].removed)) {
      if (parts[i].added) {
        runProposedLines.push(...parts[i].value)
        proposedCursor += parts[i].value.length
      } else {
        runBaselineLines.push(...parts[i].value)
        baselineCursor += parts[i].value.length
      }
      i++
    }

    const type: DiffHunkType =
      runBaselineLines.length === 0
        ? 'add'
        : runProposedLines.length === 0
          ? 'delete'
          : 'replace'

    hunks.push({
      id: `h${hunks.length}`,
      index: hunks.length,
      type,
      baselineStart: runBaselineStart,
      baselineLines: runBaselineLines,
      proposedStart: runProposedStart,
      proposedLines: runProposedLines,
      contentKey: makeContentKey(runBaselineLines, runProposedLines)
    })
  }

  return hunks
}
