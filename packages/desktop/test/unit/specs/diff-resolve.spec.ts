import { describe, expect, it } from 'vitest'
import { computeHunks } from 'common/diff'
import { resolveDocument, type HunkDecision } from 'common/diff/resolve'

// Two replace hunks: h0 on line 0, h1 on line 3.
const base = 'one\ntwo\nthree\nfour\nfive'
const prop = 'ONE\ntwo\nthree\nFOUR\nfive'
const hunks = computeHunks(base, prop)

const decisionsOf = (entries: Array<[string, HunkDecision]>): Map<string, HunkDecision> =>
  new Map(entries)

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
})
