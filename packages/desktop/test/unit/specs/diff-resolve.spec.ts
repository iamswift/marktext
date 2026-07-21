import { describe, expect, it } from 'vitest'
import { computeHunks } from 'common/diff'
import { computeEditRuns } from 'common/diff/editRuns'
import { resolveDocument, type HunkDecision } from 'common/diff/resolve'

// Two replace hunks: h0 on line 0, h1 on line 3.
const base = 'one\ntwo\nthree\nfour\nfive'
const prop = 'ONE\ntwo\nthree\nFOUR\nfive'
const hunks = computeHunks(base, prop)

const decisionsOf = (entries: Array<[string, HunkDecision]>): Map<string, HunkDecision> =>
  new Map(entries)

// A single replace hunk (surrounded by unchanged lines) whose one line carries
// three isolated typo fixes, each separated by a multi-word equal span — the
// same fixture shape diff-edit-runs.spec.ts uses to pin computeEditRuns at 3
// runs. Built via computeHunks + computeEditRuns, per the real call chain.
const runsBase = 'one\nthe priting industry is essentialy about publising\nthree'
const runsProp = 'one\nthe printing industry is essentially about publishing\nthree'
const runsHunks = computeHunks(runsBase, runsProp)
const runsHunk = runsHunks[0]
const runs = computeEditRuns(runsHunk)

describe('resolveDocument (FR-10)', () => {
  it('resolves to the proposed document when nothing is decided', () => {
    expect(resolveDocument(base, hunks, new Map())).toEqual(prop)
  })

  it('resolves to the baseline when every hunk is rejected', () => {
    const decisions = decisionsOf([
      ['h0', { kind: 'reject' }],
      ['h1', { kind: 'reject' }]
    ])
    expect(resolveDocument(base, hunks, decisions)).toEqual(base)
  })

  it('resolves to the proposed document when every hunk is accepted', () => {
    const decisions = decisionsOf([
      ['h0', { kind: 'accept' }],
      ['h1', { kind: 'accept' }]
    ])
    expect(resolveDocument(base, hunks, decisions)).toEqual(prop)
  })

  it('applies mixed decisions independently', () => {
    const decisions = decisionsOf([
      ['h0', { kind: 'accept' }],
      ['h1', { kind: 'reject' }]
    ])
    expect(resolveDocument(base, hunks, decisions)).toEqual('ONE\ntwo\nthree\nfour\nfive')
  })

  it('applies an edit decision verbatim', () => {
    const decisions = decisionsOf([
      ['h0', { kind: 'edit', lines: ['EDITED'] }],
      ['h1', { kind: 'reject' }]
    ])
    expect(resolveDocument(base, hunks, decisions)).toEqual('EDITED\ntwo\nthree\nfour\nfive')
  })

  it('is insensitive to decision insertion order', () => {
    const forward = decisionsOf([
      ['h0', { kind: 'accept' }],
      ['h1', { kind: 'reject' }]
    ])
    const backward = decisionsOf([
      ['h1', { kind: 'reject' }],
      ['h0', { kind: 'accept' }]
    ])
    expect(resolveDocument(base, hunks, backward)).toEqual(resolveDocument(base, hunks, forward))
  })

  it('is idempotent for a fully decided document', () => {
    const decisions = decisionsOf([
      ['h0', { kind: 'accept' }],
      ['h1', { kind: 'reject' }]
    ])
    const once = resolveDocument(base, hunks, decisions)
    expect(resolveDocument(once, computeHunks(once, once), new Map())).toEqual(once)
  })

  it('accepting every run produces output byte-identical to accepting the whole hunk', () => {
    expect(runs).toHaveLength(3)
    const runsDecision = decisionsOf([
      [runsHunk.id, { kind: 'runs', runs: new Map([[0, 'accept'], [1, 'accept'], [2, 'accept']]) }]
    ])
    const wholeHunkDecision = decisionsOf([[runsHunk.id, { kind: 'accept' }]])
    expect(resolveDocument(runsBase, runsHunks, runsDecision)).toEqual(
      resolveDocument(runsBase, runsHunks, wholeHunkDecision)
    )
    expect(resolveDocument(runsBase, runsHunks, runsDecision)).toEqual(runsProp)
  })

  it('rejecting every run produces output byte-identical to rejecting the whole hunk', () => {
    const runsDecision = decisionsOf([
      [runsHunk.id, { kind: 'runs', runs: new Map([[0, 'reject'], [1, 'reject'], [2, 'reject']]) }]
    ])
    const wholeHunkDecision = decisionsOf([[runsHunk.id, { kind: 'reject' }]])
    expect(resolveDocument(runsBase, runsHunks, runsDecision)).toEqual(
      resolveDocument(runsBase, runsHunks, wholeHunkDecision)
    )
    expect(resolveDocument(runsBase, runsHunks, runsDecision)).toEqual(runsBase)
  })

  it('resolves a mixed accept/reject run decision to exactly the expected line set', () => {
    const runsDecision = decisionsOf([
      [runsHunk.id, { kind: 'runs', runs: new Map([[0, 'accept'], [1, 'reject'], [2, 'accept']]) }]
    ])
    expect(resolveDocument(runsBase, runsHunks, runsDecision)).toEqual(
      'one\nthe printing industry is essentialy about publishing\nthree'
    )
  })

  it('leaves an undecided run resolved to proposed text (FR-10 at run granularity)', () => {
    // Run 1 has no entry at all — neither accepted nor rejected — and must
    // still read as the proposed word, distinguishing "undecided" from "reject".
    const runsDecision = decisionsOf([
      [runsHunk.id, { kind: 'runs', runs: new Map([[0, 'reject'], [2, 'reject']]) }]
    ])
    expect(resolveDocument(runsBase, runsHunks, runsDecision)).toEqual(
      'one\nthe priting industry is essentially about publising\nthree'
    )
  })
})
