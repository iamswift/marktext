import { diffWordsWithSpace } from 'diff'

export interface WordSpan {
  text: string
  changed: boolean
}

const mergeSpans = (spans: WordSpan[]): WordSpan[] => {
  if (spans.length <= 1) {
    return spans
  }
  const result: WordSpan[] = [{ ...spans[0] }]
  for (let i = 1; i < spans.length; i++) {
    const last = result[result.length - 1]
    if (last.changed === spans[i].changed) {
      last.text += spans[i].text
    } else {
      result.push({ ...spans[i] })
    }
  }
  return result
}

export function computeLineWordDiff(
  baseLine: string,
  propLine: string
): { base: WordSpan[]; prop: WordSpan[] } {
  const parts = diffWordsWithSpace(baseLine, propLine)

  const base: WordSpan[] = []
  const prop: WordSpan[] = []
  for (const part of parts) {
    if (!part.added) {
      base.push({ text: part.value, changed: Boolean(part.removed) })
    }
    if (!part.removed) {
      prop.push({ text: part.value, changed: Boolean(part.added) })
    }
  }

  return { base: mergeSpans(base), prop: mergeSpans(prop) }
}

export interface DeletedRun {
  /** Removed text, whitespace as produced by the word diff. */
  text: string
  /** Character offset in the proposed text where this run was removed. */
  offset: number
}

/**
 * Single-pass merged view of a replace hunk: the proposed side as WordSpans
 * (changed = inserted), plus every removed run anchored to its offset in the
 * proposed text — exactly what an inline track-changes renderer needs to
 * splice <del> elements into the rendered added fragment.
 */
export function computeMergedWordDiff(
  baseText: string,
  propText: string
): { prop: WordSpan[]; deletions: DeletedRun[] } {
  const parts = diffWordsWithSpace(baseText, propText)
  const prop: WordSpan[] = []
  const deletions: DeletedRun[] = []
  let offset = 0
  for (const part of parts) {
    if (part.removed) {
      // Removed parts consume no proposed text, so consecutive ones share an
      // offset and belong to the same run.
      const last = deletions[deletions.length - 1]
      if (last && last.offset === offset) {
        last.text += part.value
      } else {
        deletions.push({ text: part.value, offset })
      }
    } else {
      prop.push({ text: part.value, changed: Boolean(part.added) })
      offset += part.value.length
    }
  }
  return { prop: mergeSpans(prop), deletions }
}
