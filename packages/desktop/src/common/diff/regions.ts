import { normalizeText, type DiffHunk } from './index'
import { resolveRuns, type HunkDecision } from './resolve'
import { computeEditRuns } from './editRuns'

export type AnnotatedLineKind = 'context' | 'del' | 'add'

export interface AnnotatedLine {
  text: string
  kind: AnnotatedLineKind
  /** Present only on 'del'/'add' lines: the undecided hunk they belong to. */
  hunkId?: string
}

export interface RegionPart {
  role: 'context' | 'deleted' | 'added'
  hunkId?: string
  markdown: string
  /**
   * The opening fence line (e.g. "```js") when this part's lines live inside
   * a fenced code block. Renderers re-wrap the part in that fence so a
   * changed line inside a code block still renders as code.
   */
  fence?: string
  /** True when the part is only the fence delimiter line(s) themselves. */
  fenceDelimiter?: boolean
}

export type ReviewSegment =
  | { kind: 'unchanged'; markdown: string }
  | { kind: 'region'; hunkIds: string[]; parts: RegionPart[] }

const FENCE_OPEN_REG = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE_TAIL_REG = /^[ \t]*$/

/**
 * flags[i] is true when line i belongs to a multi-line atomic construct
 * (fenced code block or leading front matter) and therefore must not become a
 * split point between rendered fragments.
 */
export function computeUnsafeLineFlags(lines: readonly string[]): boolean[] {
  const flags = new Array<boolean>(lines.length).fill(false)
  if (lines.length === 0) {
    return flags
  }

  let i = 0
  if (lines[0] === '---') {
    let close = -1
    for (let j = 1; j < lines.length; j++) {
      if (lines[j] === '---' || lines[j] === '...') {
        close = j
        break
      }
    }
    // Unclosed front matter is just a thematic break — nothing atomic to protect.
    if (close !== -1) {
      for (let j = 0; j <= close; j++) {
        flags[j] = true
      }
      i = close + 1
    }
  }

  while (i < lines.length) {
    const open = lines[i].match(FENCE_OPEN_REG)
    // A backtick fence's info string cannot itself contain backticks.
    if (!open || (open[1][0] === '`' && open[2].includes('`'))) {
      i++
      continue
    }

    const fenceChar = open[1][0]
    const fenceLength = open[1].length
    flags[i] = true
    i++

    let closed = false
    while (i < lines.length) {
      const close = lines[i].match(FENCE_OPEN_REG)
      flags[i] = true
      i++
      if (
        close &&
        close[1][0] === fenceChar &&
        close[1].length >= fenceLength &&
        FENCE_CLOSE_TAIL_REG.test(close[2])
      ) {
        closed = true
        break
      }
    }
    if (!closed) {
      break
    }
  }

  return flags
}

export type FenceContext =
  | { kind: 'outside' }
  | { kind: 'delimiter'; header: string }
  | { kind: 'body'; header: string }

/**
 * Classifies every line against fenced code blocks: the open/close delimiter
 * lines, the body lines between them (tagged with the opening header so they
 * can be re-fenced for standalone rendering), and everything else. Front
 * matter is treated as outside — fences are not recognized within it.
 */
export function computeFenceContexts(lines: readonly string[]): FenceContext[] {
  const contexts: FenceContext[] = new Array(lines.length).fill({ kind: 'outside' })
  if (lines.length === 0) {
    return contexts
  }

  let i = 0
  if (lines[0] === '---') {
    for (let j = 1; j < lines.length; j++) {
      if (lines[j] === '---' || lines[j] === '...') {
        i = j + 1
        break
      }
    }
  }

  while (i < lines.length) {
    const open = lines[i].match(FENCE_OPEN_REG)
    if (!open || (open[1][0] === '`' && open[2].includes('`'))) {
      i++
      continue
    }

    const header = lines[i]
    const fenceChar = open[1][0]
    const fenceLength = open[1].length
    contexts[i] = { kind: 'delimiter', header }
    i++

    while (i < lines.length) {
      const close = lines[i].match(FENCE_OPEN_REG)
      if (
        close &&
        close[1][0] === fenceChar &&
        close[1].length >= fenceLength &&
        FENCE_CLOSE_TAIL_REG.test(close[2])
      ) {
        contexts[i] = { kind: 'delimiter', header }
        i++
        break
      }
      contexts[i] = { kind: 'body', header }
      i++
    }
  }

  return contexts
}

/**
 * Produces the merged review document as annotated lines: context from the
 * baseline, decided hunks melted into context via their resolution, undecided
 * hunks expanded to their deleted (baseline) then added (proposed) lines.
 */
export function annotateMerged(
  baseline: string,
  hunks: readonly DiffHunk[],
  decisions: ReadonlyMap<string, HunkDecision>
): AnnotatedLine[] {
  const baseLines = normalizeText(baseline).split('\n')
  const ordered = [...hunks].sort((a, b) => a.baselineStart - b.baselineStart)
  const out: AnnotatedLine[] = []
  let cursor = 0

  const pushContext = (lines: readonly string[]): void => {
    for (const text of lines) {
      out.push({ text, kind: 'context' })
    }
  }

  for (const hunk of ordered) {
    pushContext(baseLines.slice(cursor, hunk.baselineStart))
    cursor = hunk.baselineStart + hunk.baselineLines.length

    const decision = decisions.get(hunk.id)
    // A 'runs' hunk melts to context only once EVERY run carries a decision;
    // until then it is still pending and stays expanded, so the overlay can
    // decorate the individual runs inside it.
    const pendingRuns =
      decision?.kind === 'runs' &&
      computeEditRuns(hunk).some((run) => !decision.runs.has(run.index))

    if (!decision || pendingRuns) {
      for (const text of hunk.baselineLines) {
        out.push({ text, kind: 'del', hunkId: hunk.id })
      }
      for (const text of hunk.proposedLines) {
        out.push({ text, kind: 'add', hunkId: hunk.id })
      }
    } else if (decision.kind === 'runs') {
      pushContext(resolveRuns(hunk, decision.runs))
    } else if (decision.kind === 'accept') {
      pushContext(hunk.proposedLines)
    } else if (decision.kind === 'reject') {
      pushContext(hunk.baselineLines)
    } else {
      pushContext(decision.lines)
    }
  }
  pushContext(baseLines.slice(cursor))

  return out
}

/**
 * Splits the annotated document into render segments. Boundaries are placed
 * only after a blank line and outside atomic constructs — checked in both the
 * baseline view (context + del) and the proposed view (context + add), so a
 * fragment never starts or ends inside a fence in either document.
 */
export function computeRegions(annotated: readonly AnnotatedLine[]): ReviewSegment[] {
  const n = annotated.length
  if (n === 0) {
    return []
  }

  const unsafe = new Array<boolean>(n).fill(false)
  // Fence classification per annotated line, taken from the view the line
  // actually exists in: baseline (context + del) or proposed (context + add).
  const fenceCtx: FenceContext[] = new Array(n).fill({ kind: 'outside' })
  const markView = (exclude: AnnotatedLineKind): void => {
    const indices: number[] = []
    const texts: string[] = []
    for (let i = 0; i < n; i++) {
      if (annotated[i].kind !== exclude) {
        indices.push(i)
        texts.push(annotated[i].text)
      }
    }
    const flags = computeUnsafeLineFlags(texts)
    const contexts = computeFenceContexts(texts)
    for (let k = 0; k < indices.length; k++) {
      if (flags[k]) {
        unsafe[indices[k]] = true
      }
      if (contexts[k].kind !== 'outside') {
        fenceCtx[indices[k]] = contexts[k]
      }
    }
  }
  // Proposed view first so baseline classification wins for context lines.
  markView('del')
  markView('add')

  const isSafeBoundaryBefore = (i: number): boolean =>
    annotated[i - 1].text.trim() === '' && !unsafe[i - 1] && !unsafe[i]

  const segments: ReviewSegment[] = []
  let chunkStart = 0

  const emitChunk = (start: number, end: number): void => {
    const lines = annotated.slice(start, end)
    if (lines.every((l) => l.kind === 'context')) {
      const markdown = lines.map((l) => l.text).join('\n')
      const prev = segments[segments.length - 1]
      if (prev && prev.kind === 'unchanged') {
        prev.markdown += `\n${markdown}`
      } else {
        segments.push({ kind: 'unchanged', markdown })
      }
      return
    }

    const parts: RegionPart[] = []
    const hunkIds: string[] = []
    for (let i = start; i < end; i++) {
      const line = annotated[i]
      const ctx = fenceCtx[i]
      const role =
        line.kind === 'context' ? 'context' : line.kind === 'del' ? 'deleted' : 'added'
      const fence = ctx.kind === 'body' ? ctx.header : undefined
      const fenceDelimiter = ctx.kind === 'delimiter' ? true : undefined
      const prev = parts[parts.length - 1]
      if (
        prev &&
        prev.role === role &&
        prev.hunkId === line.hunkId &&
        prev.fence === fence &&
        prev.fenceDelimiter === fenceDelimiter
      ) {
        prev.markdown += `\n${line.text}`
      } else {
        parts.push({ role, hunkId: line.hunkId, markdown: line.text, fence, fenceDelimiter })
      }
      if (line.hunkId && !hunkIds.includes(line.hunkId)) {
        hunkIds.push(line.hunkId)
      }
    }
    segments.push({ kind: 'region', hunkIds, parts })
  }

  for (let i = 1; i < n; i++) {
    if (isSafeBoundaryBefore(i)) {
      emitChunk(chunkStart, i)
      chunkStart = i
    }
  }
  emitChunk(chunkStart, n)

  return segments
}
