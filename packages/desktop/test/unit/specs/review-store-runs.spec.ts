import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.hoisted(() => {
  const w = globalThis as unknown as {
    window?: {
      path?: { sep: string; dirname: (p: string) => string }
      fileUtils?: { isSamePathSync: (a: string, b: string) => boolean }
      electron?: {
        ipcRenderer: { send: (...a: unknown[]) => void; on: Mock; invoke: Mock }
      }
    }
  }
  w.window ??= {}
  w.window.path ??= { sep: '/', dirname: (p: string) => p }
  w.window.fileUtils ??= { isSamePathSync: (a, b) => a === b }
  w.window.electron ??= {
    ipcRenderer: { send: () => {}, on: vi.fn(), invoke: vi.fn() }
  }
})

vi.mock('@/services/notification', () => ({
  default: { notify: vi.fn(), name: 'notify' }
}))
vi.mock('@/store/bufferedState', () => ({ debouncedSendBufferedState: vi.fn() }))

import { useReviewStore } from '@/store/review'
import type { IFileState } from '@shared/types/files'

// A single replace hunk with two independent word-level edit runs:
// run 0 'quick'->'slow', run 1 'jumps'->'leaps' (verified against
// diffWordsWithSpace directly — 'fox' between them carries a real word, so
// the two edits do not merge into one run).
const base = 'the quick fox jumps over\ntwo\nthree'
const prop = 'the slow fox leaps over\ntwo\nthree'

const makeTab = (): IFileState =>
  ({
    id: 'tab-1',
    filename: 'a.md',
    pathname: '/x/a.md',
    markdown: base,
    isSaved: true
  }) as unknown as IFileState

const change = (markdown: string) => ({
  pathname: '/x/a.md',
  data: {
    markdown,
    filename: 'a.md',
    lineEnding: 'lf',
    adjustLineEndingOnSave: false,
    trimTrailingNewline: 2,
    encoding: { encoding: 'utf8', isBom: false }
  }
})

const invokeMock = () => window.electron.ipcRenderer.invoke as Mock
const writtenMarkdown = (call: number) => invokeMock().mock.calls[call][2] as string

describe('useReviewStore run decisions (US-006)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    invokeMock().mockResolvedValue(undefined)
  })

  it('decideRun records a decision and pendingRunCount drops', async() => {
    const store = useReviewStore()
    store.enterReview(makeTab(), change(prop))
    const hunkId = store.hunks[0].id

    expect(store.pendingRunCount(hunkId)).toBe(2)

    await store.decideRun(hunkId, 0, 'accept')

    expect(store.runDecisions.get(hunkId)?.get(0)).toBe('accept')
    expect(store.pendingRunCount(hunkId)).toBe(1)
  })

  it('revertRun clears exactly one run and leaves siblings decided', async() => {
    const store = useReviewStore()
    store.enterReview(makeTab(), change(prop))
    const hunkId = store.hunks[0].id

    await store.decideRun(hunkId, 0, 'accept')
    await store.decideRun(hunkId, 1, 'reject')
    expect(store.pendingRunCount(hunkId)).toBe(0)

    await store.revertRun(hunkId, 0)

    expect(store.runDecisions.get(hunkId)?.has(0)).toBe(false)
    expect(store.runDecisions.get(hunkId)?.get(1)).toBe('reject')
    expect(store.pendingRunCount(hunkId)).toBe(1)
  })

  it('runDecisions is empty after enterReview', () => {
    const store = useReviewStore()
    store.enterReview(makeTab(), change(prop))
    expect(store.runDecisions.size).toBe(0)
  })

  it('runDecisions is empty after exitReview', async() => {
    const store = useReviewStore()
    store.enterReview(makeTab(), change(prop))
    const hunkId = store.hunks[0].id
    await store.decideRun(hunkId, 0, 'accept')
    expect(store.runDecisions.size).toBe(1)

    store.exitReview()

    expect(store.runDecisions.size).toBe(0)
  })

  it('runDecisions is empty after restartAgainstNewDisk', async() => {
    const store = useReviewStore()
    store.enterReview(makeTab(), change(prop))
    const hunkId = store.hunks[0].id
    await store.decideRun(hunkId, 0, 'accept')
    expect(store.runDecisions.size).toBe(1)

    // A second external write that still differs from the frozen baseline,
    // so the restart re-diffs rather than exiting review outright.
    const prop2 = 'the slow fox leaps over\ntwo\nTHREE'
    await store.restartAgainstNewDisk(change(prop2))

    expect(store.active).toBe(true)
    expect(store.runDecisions.size).toBe(0)
  })

  it('a run decision writes through the existing chain with the run resolved', async() => {
    const store = useReviewStore()
    store.enterReview(makeTab(), change(prop))
    const hunkId = store.hunks[0].id

    // Reject run 1 ('jumps'->'leaps') only; run 0 ('quick'->'slow') has no
    // decision yet, so FR-10 keeps it proposed.
    await store.decideRun(hunkId, 1, 'reject')

    expect(invokeMock()).toHaveBeenCalledTimes(1)
    expect(invokeMock().mock.calls[0][0]).toBe('mt::review-write-file')
    expect(invokeMock().mock.calls[0][1]).toBe('/x/a.md')
    expect(writtenMarkdown(0)).toBe('the slow fox jumps over\ntwo\nthree')
  })
})
