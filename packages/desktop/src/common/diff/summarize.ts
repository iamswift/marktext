import { diffWordsWithSpace } from 'diff'
import { INLINE_MAX_RUN_WORDS } from './classify'
import type { DiffHunk } from './index'

/**
 * What kind of change a hunk is, as a descriptor rather than a sentence: the
 * renderer holds the copy so these stay translatable. `count` is always a
 * digit for the caller to interpolate — spelling numbers out is unlocalizable.
 */
export type HunkKind =
  | { key: 'wordsFixed'; count: number }
  | { key: 'paragraphsRevised'; count: number }
  | { key: 'sentenceRewritten' }
  | { key: 'paragraphAdded'; count: number }
  | { key: 'paragraphRemoved'; count: number }
  | { key: 'linesChanged'; count: number }

/** A one-line "what changed" summary for a review card. */
export type HunkDelta =
  | { kind: 'replace'; oldText: string; newText: string }
  | { kind: 'preview'; side: 'new' | 'old'; text: string; truncated: boolean }
  | { kind: 'bulk'; lines: number }

/** At or under this, a run reads as a typo fix rather than a reworded phrase. */
export const SMALL_RUN_WORDS = 2

const DEFAULT_MAX_OLD_CHARS = 42
const DEFAULT_PREVIEW_CHARS = 48
/** Keeps a one-word-to-two-sentence swap from making the card 400px tall. */
const MAX_NEW_CHARS = 96

/** Lines where "paragraph" would be the wrong noun. */
const NON_PROSE = [
  /^\s*(?:[-*+]|\d+[.)])\s/, // list item
  /^\s*#/, // heading
  /^\s*\|/, // table row
  /^\s*(?:`{3,}|~{3,})/, // fence delimiter
  /^\s{4,}\S/ // indented code
]

const wordCount = (text: string): number => {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

/** Maximal runs of non-blank lines — i.e. how many paragraphs a side spans. */
const blockCount = (lines: readonly string[]): number => {
  let blocks = 0
  let inBlock = false
  for (const line of lines) {
    if (line.trim() === '') {
      inBlock = false
    } else if (!inBlock) {
      blocks++
      inBlock = true
    }
  }
  return blocks
}

interface LabelMetrics {
  maxRunWords: number
  runCount: number
}

/**
 * Word-run metrics for labelling, which are deliberately NOT
 * `computeHunkMetrics`. The classifier keeps a run alive across a single
 * shared word, because one incidental match mid-rewrite does not make two
 * separate edits for a reader parsing the sentence. A label wants the
 * opposite: "the priting industry is essentialy about publising" has three
 * distinct typos, and the shared "about" between two of them must not merge
 * them into one run of four. Reset on any equal part carrying a real word.
 */
const labelMetrics = (hunk: DiffHunk): LabelMetrics => {
  const parts = diffWordsWithSpace(
    hunk.baselineLines.join('\n'),
    hunk.proposedLines.join('\n')
  )
  let maxRunWords = 0
  let runCount = 0
  let run = 0
  for (const part of parts) {
    if (part.added || part.removed) {
      if (run === 0) {
        runCount++
      }
      run += wordCount(part.value)
      if (run > maxRunWords) {
        maxRunWords = run
      }
    } else if (wordCount(part.value) > 0) {
      run = 0
    }
  }
  return { maxRunWords, runCount }
}

const changedWords = (hunk: DiffHunk): { oldWords: string[]; newWords: string[] } => {
  const parts = diffWordsWithSpace(
    hunk.baselineLines.join('\n'),
    hunk.proposedLines.join('\n')
  )
  const oldWords: string[] = []
  const newWords: string[] = []
  for (const part of parts) {
    const text = part.value.trim()
    if (text === '') {
      continue
    }
    if (part.removed) {
      oldWords.push(text)
    } else if (part.added) {
      newWords.push(text)
    }
  }
  return { oldWords, newWords }
}

const firstNonBlank = (lines: readonly string[]): string =>
  lines.find((line) => line.trim() !== '')?.trim() ?? ''

const preview = (
  side: 'new' | 'old',
  text: string,
  previewChars: number
): HunkDelta => ({
  kind: 'preview',
  side,
  text: text.slice(0, previewChars),
  truncated: text.length > previewChars
})

/**
 * Both helpers re-run the word diff, and a card recomputes on every store
 * mutation. `contentKey` is already a content fingerprint, so a hit is always
 * safe; the cap just stops a long session from growing the map forever.
 */
const CACHE_LIMIT = 256
const kindCache = new Map<string, HunkKind>()
const deltaCache = new Map<string, HunkDelta>()

const memoize = <T>(cache: Map<string, T>, key: string, compute: () => T): T => {
  const hit = cache.get(key)
  if (hit !== undefined) {
    return hit
  }
  const value = compute()
  if (cache.size >= CACHE_LIMIT) {
    cache.clear()
  }
  cache.set(key, value)
  return value
}

/** Names the change for a review card's heading line. */
export function describeHunk(hunk: DiffHunk): HunkKind {
  return memoize(kindCache, hunk.contentKey, () => {
    const changedLines = [...hunk.baselineLines, ...hunk.proposedLines]
    if (changedLines.some((line) => NON_PROSE.some((pattern) => pattern.test(line)))) {
      return {
        key: 'linesChanged',
        count: Math.max(hunk.baselineLines.length, hunk.proposedLines.length)
      }
    }

    if (hunk.type === 'add') {
      return { key: 'paragraphAdded', count: blockCount(hunk.proposedLines) }
    }
    if (hunk.type === 'delete') {
      return { key: 'paragraphRemoved', count: blockCount(hunk.baselineLines) }
    }

    // Block count outranks word count: two paragraphs of typos are better
    // described by their span than by how many words moved.
    const blocks = Math.max(blockCount(hunk.baselineLines), blockCount(hunk.proposedLines))
    if (blocks > 1) {
      return { key: 'paragraphsRevised', count: blocks }
    }

    const metrics = labelMetrics(hunk)
    if (metrics.maxRunWords <= SMALL_RUN_WORDS) {
      return { key: 'wordsFixed', count: metrics.runCount }
    }
    if (metrics.runCount === 1 && metrics.maxRunWords > INLINE_MAX_RUN_WORDS) {
      return { key: 'sentenceRewritten' }
    }
    return { key: 'paragraphsRevised', count: 1 }
  })
}

/**
 * The old-to-new summary a card shows under its heading. Only the OLD side is
 * length-gated: the reader anchors on what is being replaced, so a long
 * replacement for a short original still reads fine, while a long original is
 * the signal that this is a bulk rewrite rather than a word swap.
 */
export function summarizeHunk(
  hunk: DiffHunk,
  opts?: { maxOldChars?: number; previewChars?: number }
): HunkDelta {
  const maxOldChars = opts?.maxOldChars ?? DEFAULT_MAX_OLD_CHARS
  const previewChars = opts?.previewChars ?? DEFAULT_PREVIEW_CHARS
  const cacheable = opts === undefined

  const compute = (): HunkDelta => {
    if (hunk.baselineLines.length === 0) {
      return preview('new', firstNonBlank(hunk.proposedLines), previewChars)
    }
    if (hunk.proposedLines.length === 0) {
      return preview('old', firstNonBlank(hunk.baselineLines), previewChars)
    }

    const { oldWords, newWords } = changedWords(hunk)
    if (oldWords.length === 0) {
      return preview('new', newWords.join(' '), previewChars)
    }

    const oldText = oldWords.join(', ')
    if (oldText.length > maxOldChars) {
      return { kind: 'bulk', lines: hunk.baselineLines.length }
    }

    const joined = newWords.join(', ')
    const newText =
      joined.length > MAX_NEW_CHARS ? `${joined.slice(0, MAX_NEW_CHARS)}…` : joined
    return { kind: 'replace', oldText, newText }
  }

  return cacheable ? memoize(deltaCache, hunk.contentKey, compute) : compute()
}
