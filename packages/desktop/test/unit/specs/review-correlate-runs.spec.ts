import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderToStaticHTML } from '@muyajs/core'
import { computeHunks, type DiffHunk } from 'common/diff'
import { classifyHunk } from 'common/diff/classify'
import {
  alignRuns,
  computeEditRuns,
  computeTextRuns,
  normalizeRunText,
  type EditRun
} from 'common/diff/editRuns'
import { correlateRuns, isSingleParagraph } from '@/util/reviewInlineMerge'

let seq = 0
const hunk = (baselineLines: string[], proposedLines: string[]): DiffHunk => ({
  id: `h${seq}`,
  index: 0,
  type: 'replace',
  baselineStart: 0,
  baselineLines,
  proposedStart: 0,
  proposedLines,
  // Unique per construction so nothing accidentally keys off a shared fingerprint.
  contentKey: `k${seq++}`
})

const addHunk = (proposedLines: string[]): DiffHunk => ({
  id: `h${seq}`,
  index: 0,
  type: 'add',
  baselineStart: 0,
  baselineLines: [],
  proposedStart: 0,
  proposedLines,
  contentKey: `k${seq++}`
})

const el = (html: string): HTMLElement => {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

describe('correlateRuns', () => {
  it('does not veto the hunk on a syntax-only run beside a real typo fix', () => {
    // **bold** -> _bold_ is a pure formatting swap; "teh" -> "the" is a real
    // content fix. The formatting run must be filed as syntaxOnly, not cause
    // the whole hunk to fall back to null (R2 before R3).
    const h = hunk(['this is **bold** and teh text'], ['this is _bold_ and the text'])
    const deletedRoot = el('<p>this is bold and teh text</p>')
    const addedRoot = el('<p>this is bold and the text</p>')

    const result = correlateRuns(h, deletedRoot, addedRoot)

    expect(result).not.toBeNull()
    expect(result?.decidable).toHaveLength(1)
    expect(result?.syntaxOnly).toHaveLength(1)
    expect(result?.decidable[0].delText).toBe('teh')
    expect(result?.decidable[0].addText).toBe('the')
    expect(result?.syntaxOnly[0].delText).toBe('**bold**')
    expect(result?.syntaxOnly[0].addText).toBe('_bold_')
  })

  it('returns null when a genuinely unalignable content run cannot be correlated', () => {
    // The rendered text diverges from the source diff in a way alignRuns
    // cannot reconcile (rendered text bears no relation to the source
    // change), so R3 must veto the whole hunk.
    const h = hunk(['the priting industry'], ['the printing industry'])
    const deletedRoot = el('<p>completely unrelated content here</p>')
    const addedRoot = el('<p>totally different rendered text</p>')

    const result = correlateRuns(h, deletedRoot, addedRoot)

    expect(result).toBeNull()
  })

  it('returns null for a non-replace hunk', () => {
    const h = addHunk(['a brand new paragraph'])
    const deletedRoot = el('<p></p>')
    const addedRoot = el('<p>a brand new paragraph</p>')

    expect(correlateRuns(h, deletedRoot, addedRoot)).toBeNull()
  })

  it('returns null when the deleted fragment is not a single paragraph', () => {
    const h = hunk(['the priting industry'], ['the printing industry'])
    const deletedRoot = el('<p>the priting</p><p>industry</p>')
    const addedRoot = el('<p>the printing industry</p>')

    expect(correlateRuns(h, deletedRoot, addedRoot)).toBeNull()
  })

  it('returns null when the added fragment is not a single paragraph', () => {
    const h = hunk(['the priting industry'], ['the printing industry'])
    const deletedRoot = el('<p>the priting industry</p>')
    const addedRoot = el('<ul><li>the printing industry</li></ul>')

    expect(correlateRuns(h, deletedRoot, addedRoot)).toBeNull()
  })

  it('returns all runs as decidable with zero syntaxOnly for a clean multi-typo paragraph', () => {
    const h = hunk(
      ['the priting industry is essentialy about publising'],
      ['the printing industry is essentially about publishing']
    )
    const deletedRoot = el('<p>the priting industry is essentialy about publising</p>')
    const addedRoot = el('<p>the printing industry is essentially about publishing</p>')

    const result = correlateRuns(h, deletedRoot, addedRoot)

    expect(result).not.toBeNull()
    expect(result?.decidable).toHaveLength(3)
    expect(result?.syntaxOnly).toHaveLength(0)
  })

  it('returns null when every run is syntax-only, so the hunk still gets a decision', () => {
    // Nothing here is decidable change-by-change, but the reviewer must still
    // be able to reject the reformatting. A correlation with an empty
    // decidable set would seed the hunk fully decided and slip it past them.
    const h = hunk(['this is **bold** text'], ['this is _bold_ text'])
    const deletedRoot = el('<p>this is bold text</p>')
    const addedRoot = el('<p>this is bold text</p>')

    expect(correlateRuns(h, deletedRoot, addedRoot)).toBeNull()
  })

  it('returns source runs (not rendered runs) whose offsets slice correctly out of the hunk source text', () => {
    const h = hunk(['this is **bold** and teh text'], ['this is _bold_ and the text'])
    const deletedRoot = el('<p>this is bold and teh text</p>')
    const addedRoot = el('<p>this is bold and the text</p>')

    const result = correlateRuns(h, deletedRoot, addedRoot)

    expect(result).not.toBeNull()
    const baselineText = h.baselineLines.join('\n')
    const proposedText = h.proposedLines.join('\n')
    for (const run of [...(result?.decidable ?? []), ...(result?.syntaxOnly ?? [])]) {
      expect(baselineText.slice(run.baseStart, run.baseEnd)).toBe(run.delText)
      expect(proposedText.slice(run.propStart, run.propEnd)).toBe(run.addText)
    }
  })
})

/**
 * US-005: corpus measurement gate.
 *
 * `correlateRuns`'s doc comment is explicit that it is deliberately
 * conservative: any doubt resolves to `null` and the caller falls back to
 * hunk-level Keep/Undo. That conservatism is only safe if it is RARE — a
 * guard that vetoes most real edits makes the per-change decision feature
 * unreachable even though the code path exists. This suite measures the veto
 * rate against markdown documents shaped like a real AI editing pass
 * (multi-paragraph prose, several change types mixed within one document)
 * rather than the isolated one-liners above, and on failure reports WHY each
 * hunk missed rather than just how many.
 *
 * Fixtures are paired `<name>.baseline.md` / `<name>.proposed.md` files under
 * `test/unit/fixtures/edit-runs/` rather than inline template strings:
 * multi-paragraph prose is far more readable — and easier to judge as
 * genuinely "realistic" in review — as actual markdown files than as escaped
 * strings inside a spec.
 */
describe('correlateRuns corpus gate (US-005)', () => {
  const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'edit-runs')
  const FIXTURE_DOCS = [
    '01-typo-fixes',
    '02-word-phrase-swaps',
    '03-formatting-changes',
    '04-sentence-rewrites',
    '05-paragraph-split',
    '06-list-edits',
    '07-mixed-editing-pass'
  ]

  const MIN_CORRELATION_PERCENT = 85

  type MissReason =
    // Hunk fails correlateRuns's own precondition: not `replace`, or not a
    // single rendered <p> on one (or both) sides.
    | 'structural'
    // R3: a content run (already cleared of R2's syntax-only bucket) has no
    // matching rendered run.
    | 'unalignable-content'
    // Every source run in the hunk normalized as syntax-only — R2's own
    // documented null case (see the "every run is syntax-only" test above),
    // not a correlation failure.
    | 'all-syntax-only'
    | 'other'

  interface Miss {
    doc: string
    hunkId: string
    reason: MissReason
    sample: string
    /**
     * True when every unalignable content run is ALSO textually identical
     * under a normalization broader than `normalizeRunText`'s (which only
     * strips `* _ \``). A true value means R2's marker-stripping missed a
     * formatting-only rewrite and let it reach R3 as if it were content —
     * exactly the bug class R2 exists to prevent, so this must stay empty
     * across the corpus.
     */
    formattingOnlySuspect: boolean
  }

  const truncate = (text: string, max = 70): string =>
    text.length > max ? `${text.slice(0, max)}…` : text

  const broadNormalize = (text: string): string =>
    text
      .normalize('NFC')
      .replace(/[*_`~#>[\]()!-]/g, '')
      .replace(/\s+/g, ' ')
      .trim()

  /**
   * Re-derives WHY `correlateRuns` returned null for one hunk, walking the
   * same exported building blocks it's made of (isSingleParagraph,
   * computeEditRuns, normalizeRunText, alignRuns) in the same order. The
   * pass/fail verdict below always comes from calling the real
   * `correlateRuns`; this only explains a null after the fact so a failing
   * assertion says where to look instead of just how often it happened.
   */
  const classifyMiss = (
    doc: string,
    hunk: DiffHunk,
    deletedRoot: HTMLElement,
    addedRoot: HTMLElement
  ): Miss => {
    if (!isSingleParagraph(deletedRoot) || !isSingleParagraph(addedRoot)) {
      return {
        doc,
        hunkId: hunk.id,
        reason: 'structural',
        sample: `deleted=<${truncate(deletedRoot.innerHTML)}> added=<${truncate(addedRoot.innerHTML)}>`,
        formattingOnlySuspect: false
      }
    }

    const sourceRuns = computeEditRuns(hunk)
    const contentRuns: EditRun[] = []
    const syntaxOnly: EditRun[] = []
    for (const run of sourceRuns) {
      if (normalizeRunText(run.delText) === normalizeRunText(run.addText)) {
        syntaxOnly.push(run)
      } else {
        contentRuns.push(run)
      }
    }

    if (contentRuns.length === 0) {
      return {
        doc,
        hunkId: hunk.id,
        reason: 'all-syntax-only',
        sample: syntaxOnly.map((r) => `"${r.delText}" -> "${r.addText}"`).join(', '),
        formattingOnlySuspect: false
      }
    }

    const renderedRuns = computeTextRuns(
      hunk.id,
      deletedRoot.textContent ?? '',
      addedRoot.textContent ?? ''
    )
    const alignment = alignRuns(contentRuns, renderedRuns)
    const unaligned = contentRuns.filter((_run, i) => alignment[i] === null)

    if (unaligned.length > 0) {
      return {
        doc,
        hunkId: hunk.id,
        reason: 'unalignable-content',
        sample: unaligned.map((r) => `"${r.delText}" -> "${r.addText}"`).join(', '),
        formattingOnlySuspect: unaligned.every(
          (r) => broadNormalize(r.delText) === broadNormalize(r.addText)
        )
      }
    }

    return {
      doc,
      hunkId: hunk.id,
      reason: 'other',
      sample: `deleted="${truncate(deletedRoot.textContent ?? '')}" added="${truncate(addedRoot.textContent ?? '')}"`,
      formattingOnlySuspect: false
    }
  }

  const formatBreakdown = (misses: Miss[], total: number, hits: number): string => {
    const byReason = new Map<MissReason, Miss[]>()
    for (const miss of misses) {
      const bucket = byReason.get(miss.reason) ?? []
      bucket.push(miss)
      byReason.set(miss.reason, bucket)
    }

    const percent = total === 0 ? 0 : (hits / total) * 100
    const lines: string[] = [
      `correlateRuns matched ${hits}/${total} inline-classified replace hunks ` +
        `(${percent.toFixed(1)}%), need >= ${MIN_CORRELATION_PERCENT}%.`
    ]

    for (const [reason, group] of byReason) {
      const byDoc = new Map<string, number>()
      for (const m of group) {
        byDoc.set(m.doc, (byDoc.get(m.doc) ?? 0) + 1)
      }
      lines.push(
        `\n[${reason}] ${group.length} miss(es) - ` +
          Array.from(byDoc.entries())
            .map(([doc, count]) => `${doc}:${count}`)
            .join(', ')
      )
      for (const sample of group.slice(0, 3)) {
        lines.push(`  ${sample.hunkId}: ${sample.sample}`)
      }
    }

    return lines.join('\n')
  }

  it(`correlates >= ${MIN_CORRELATION_PERCENT}% of inline-classified replace hunks, with zero formatting-only vetoes`, () => {
    let total = 0
    let hits = 0
    const misses: Miss[] = []

    for (const doc of FIXTURE_DOCS) {
      const baseline = readFileSync(join(FIXTURE_DIR, `${doc}.baseline.md`), 'utf8')
      const proposed = readFileSync(join(FIXTURE_DIR, `${doc}.proposed.md`), 'utf8')

      const hunks = computeHunks(baseline, proposed).filter(
        (h) => h.type === 'replace' && classifyHunk(h) === 'inline'
      )

      for (const h of hunks) {
        total++

        const deletedRoot = document.createElement('div')
        const addedRoot = document.createElement('div')
        deletedRoot.innerHTML = renderToStaticHTML(h.baselineLines.join('\n'))
        addedRoot.innerHTML = renderToStaticHTML(h.proposedLines.join('\n'))

        const result = correlateRuns(h, deletedRoot, addedRoot)
        if (result !== null) {
          hits++
        } else {
          misses.push(classifyMiss(doc, h, deletedRoot, addedRoot))
        }
      }
    }

    const message = formatBreakdown(misses, total, hits)
    console.log(message)

    // Zero tolerance: an R3 veto whose only unalignable runs are
    // formatting-only would mean R2 has a stripping gap (see
    // classifyMiss/broadNormalize above) — that must never happen, checked
    // before the overall bar so this specific failure mode is never masked
    // by an otherwise-passing percentage.
    const formattingOnlyMisses = misses.filter((m) => m.formattingOnlySuspect)
    expect(formattingOnlyMisses, message).toHaveLength(0)

    const percentage = total === 0 ? 0 : (hits / total) * 100
    expect(percentage, message).toBeGreaterThanOrEqual(MIN_CORRELATION_PERCENT)
  })
})
