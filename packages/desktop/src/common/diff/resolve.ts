import { normalizeText, type DiffHunk } from './index'
import { computeEditRuns } from './editRuns'

export type HunkDecision =
  | { kind: 'accept' }
  | { kind: 'reject' }
  | { kind: 'edit'; lines: string[] }
  | { kind: 'runs'; runs: Map<number, 'accept' | 'reject'> }

/**
 * FR-10: undecided hunks resolve to their proposed text, because the external
 * tool's write already put that text on disk — a partial review must never
 * silently revert changes the user hasn't looked at yet. Rejecting is the only
 * action that removes a change from disk.
 */
export function resolveDocument(
  baseline: string,
  hunks: readonly DiffHunk[],
  decisions: ReadonlyMap<string, HunkDecision>
): string {
  const baseLines = normalizeText(baseline).split('\n')
  const ordered = [...hunks].sort((a, b) => a.baselineStart - b.baselineStart)
  const out: string[] = []
  let cursor = 0

  for (const hunk of ordered) {
    out.push(...baseLines.slice(cursor, hunk.baselineStart))
    cursor = hunk.baselineStart + hunk.baselineLines.length

    const decision = decisions.get(hunk.id)
    if (!decision || decision.kind === 'accept') {
      out.push(...hunk.proposedLines)
    } else if (decision.kind === 'reject') {
      out.push(...hunk.baselineLines)
    } else if (decision.kind === 'runs') {
      out.push(...resolveRuns(hunk, decision.runs))
    } else {
      out.push(...decision.lines)
    }
  }
  out.push(...baseLines.slice(cursor))

  return out.join('\n')
}

/**
 * Splices a partially-decided hunk over its PROPOSED text, one run at a time.
 * FR-10 holds at run granularity too: a run with no entry in `runsDecision`
 * (neither accepted nor rejected) is left as proposed, since that's already
 * what's on disk — only an explicit reject reverts a run to `delText`.
 */
export const resolveRuns = (
  hunk: DiffHunk,
  runsDecision: ReadonlyMap<number, 'accept' | 'reject'>
): string[] => {
  let text = hunk.proposedLines.join('\n')
  const runs = computeEditRuns(hunk)
  // Splice back-to-front so a replaced run never shifts the propStart/propEnd
  // offsets of runs still waiting to be spliced.
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]
    if (runsDecision.get(run.index) === 'reject') {
      text = text.slice(0, run.propStart) + run.delText + text.slice(run.propEnd)
    }
  }
  return text.split('\n')
}
