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
