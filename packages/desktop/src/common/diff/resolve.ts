import { normalizeText, type DiffHunk } from './index'

export type HunkDecision =
  | { kind: 'accept' }
  | { kind: 'reject' }
  | { kind: 'edit'; lines: string[] }

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
    } else {
      out.push(...decision.lines)
    }
  }
  out.push(...baseLines.slice(cursor))

  return out.join('\n')
}
