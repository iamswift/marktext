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

import { useEditorStore } from '@/store/editor'
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

// A single replace hunk with three independent word-level edit runs:
// run 0 'quick'->'slow', run 1 'jumps'->'leaps', run 2 'lazy'->'sleepy'
// (verified against diffWordsWithSpace directly — 'fox' and 'over the'
// between them carry real words, so the three edits stay separate runs).
const base3 = 'the quick fox jumps over the lazy dog\ntwo\nthree'
const prop3 = 'the slow fox leaps over the sleepy dog\ntwo\nthree'

const makeTab3 = (): IFileState =>
  ({
    id: 'tab-1',
    filename: 'a.md',
    pathname: '/x/a.md',
    markdown: base3,
    isSaved: true
  }) as unknown as IFileState

// The same three-run paragraph plus an unrelated second hunk on line 3, so a
// hunk can finish resolving through its runs while a sibling hunk is still
// undecided (h0 = paragraph, h1 = 'three' -> 'THREE').
const baseMulti = 'the quick fox jumps over the lazy dog\ntwo\nthree'
const propMulti = 'the slow fox leaps over the sleepy dog\ntwo\nTHREE'

const makeTabMulti = (): IFileState =>
  ({
    id: 'tab-1',
    filename: 'a.md',
    pathname: '/x/a.md',
    markdown: baseMulti,
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
    // US-011: decideRun now debounces its write (~400ms) rather than writing
    // synchronously, so the assertion has to advance past that window.
    vi.useFakeTimers()
    try {
      const store = useReviewStore()
      store.enterReview(makeTab(), change(prop))
      const hunkId = store.hunks[0].id

      // Reject run 1 ('jumps'->'leaps') only; run 0 ('quick'->'slow') has no
      // decision yet, so FR-10 keeps it proposed.
      await store.decideRun(hunkId, 1, 'reject')
      expect(invokeMock()).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(400)

      expect(invokeMock()).toHaveBeenCalledTimes(1)
      expect(invokeMock().mock.calls[0][0]).toBe('mt::review-write-file')
      expect(invokeMock().mock.calls[0][1]).toBe('/x/a.md')
      expect(writtenMarkdown(0)).toBe('the slow fox jumps over\ntwo\nthree')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('useReviewStore debounced write coalescing (US-011)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    invokeMock().mockResolvedValue(undefined)
  })

  it('five rapid run decisions inside the debounce window produce exactly one write', async() => {
    vi.useFakeTimers()
    try {
      const store = useReviewStore()
      store.enterReview(makeTabMulti(), change(propMulti))
      const [paragraphHunk] = store.hunks
      store.setDecidableRuns(paragraphHunk.id, [0, 1, 2])

      // Five decisions touching the same run, none of them completing the
      // hunk (run 2 stays undecided) or the review (the sibling line hunk
      // stays undecided too) — every one must go through the debounced path.
      await store.decideRun(paragraphHunk.id, 0, 'accept')
      await store.decideRun(paragraphHunk.id, 1, 'accept')
      await store.decideRun(paragraphHunk.id, 1, 'reject')
      await store.revertRun(paragraphHunk.id, 1)
      await store.decideRun(paragraphHunk.id, 1, 'accept')

      expect(invokeMock()).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(400)

      expect(invokeMock()).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a max-wait timer forces a flush at the 2s mark despite continuous 300ms decisions', async() => {
    vi.useFakeTimers()
    try {
      const store = useReviewStore()
      store.enterReview(makeTabMulti(), change(propMulti))
      const [paragraphHunk] = store.hunks
      store.setDecidableRuns(paragraphHunk.id, [0, 1, 2])

      let toggled = false
      const click = async(): Promise<void> => {
        if (toggled) {
          await store.revertRun(paragraphHunk.id, 0)
        } else {
          await store.decideRun(paragraphHunk.id, 0, 'accept')
        }
        toggled = !toggled
      }

      // t=0: the first decision starts both the 400ms debounce and the
      // 2000ms max-wait. Six more decisions every 300ms (t=300..1800) each
      // reset only the debounce, so nothing should have flushed by t=1800.
      await click()
      for (let t = 300; t <= 1800; t += 300) {
        await vi.advanceTimersByTimeAsync(300)
        await click()
      }
      expect(invokeMock()).not.toHaveBeenCalled()

      // Crossing the 2000ms mark fires the max-wait backstop even though the
      // debounce window (last reset at t=1800) wouldn't elapse until t=2200.
      await vi.advanceTimersByTimeAsync(300)
      expect(invokeMock()).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('exiting review flushes a pending debounced run write before teardown', async() => {
    const store = useReviewStore()
    store.enterReview(makeTab(), change(prop))
    const hunkId = store.hunks[0].id

    await store.decideRun(hunkId, 1, 'reject')
    expect(invokeMock()).not.toHaveBeenCalled()

    store.exitReview()
    // exitReview's flush is fire-and-forget (many of its own callers don't
    // await it either), so let the already-queued write settle before
    // asserting — its synchronous prefix ran inline before state was reset.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(invokeMock()).toHaveBeenCalledTimes(1)
    expect(writtenMarkdown(0)).toBe('the slow fox jumps over\ntwo\nthree')
    expect(store.active).toBe(false)
  })

  it('a bulk action (acceptAll) flushes a pending run write instead of losing it', async() => {
    const store = useReviewStore()
    const loadChangeSpy = vi
      .spyOn(useEditorStore(), 'loadChange')
      .mockImplementation(() => {})
    store.enterReview(makeTabMulti(), change(propMulti))
    const [paragraphHunk] = store.hunks
    store.setDecidableRuns(paragraphHunk.id, [0, 1, 2])

    await store.decideRun(paragraphHunk.id, 0, 'reject')
    expect(invokeMock()).not.toHaveBeenCalled()

    await store.acceptAll()

    // One write, not two: acceptAll cancels the pending debounce and its own
    // write already reflects the earlier manual reject on run 0.
    expect(invokeMock()).toHaveBeenCalledTimes(1)
    expect(writtenMarkdown(0)).toBe('the quick fox leaps over the sleepy dog\ntwo\nTHREE')
    expect(store.active).toBe(false)
    expect(loadChangeSpy).toHaveBeenCalledTimes(1)
  })

  it('a failed write on the last run decision preserves it, and retryWrite recovers', async() => {
    const store = useReviewStore()
    const loadChangeSpy = vi
      .spyOn(useEditorStore(), 'loadChange')
      .mockImplementation(() => {})
    store.enterReview(makeTab(), change(prop))
    const hunkId = store.hunks[0].id
    store.setDecidableRuns(hunkId, [0, 1])
    invokeMock().mockRejectedValue(new Error('EBUSY: locked'))

    await store.decideRun(hunkId, 0, 'accept')
    // The last decidable run of the only hunk: finalize needs the write, so
    // this attempts immediately instead of debouncing — and fails.
    await store.decideRun(hunkId, 1, 'reject')

    expect(store.writeState).toBe('error')
    expect(store.runDecisions.get(hunkId)?.get(1)).toBe('reject')
    expect(store.active).toBe(true)
    expect(loadChangeSpy).not.toHaveBeenCalled()

    invokeMock().mockResolvedValue(undefined)
    await store.retryWrite()

    expect(store.active).toBe(false)
    expect(loadChangeSpy).toHaveBeenCalledTimes(1)
  })
})

describe('useReviewStore hunk decided-ness and bulk fill (US-007)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    invokeMock().mockResolvedValue(undefined)
  })

  it('hunk-level accept after two individual Keeps is byte-identical to keeping every run', async() => {
    const storeA = useReviewStore()
    vi.spyOn(useEditorStore(), 'loadChange').mockImplementation(() => {})
    storeA.enterReview(makeTab3(), change(prop3))
    const hunkIdA = storeA.hunks[0].id
    storeA.setDecidableRuns(hunkIdA, [0, 1, 2])

    await storeA.decideRun(hunkIdA, 0, 'accept')
    await storeA.decideRun(hunkIdA, 1, 'accept')
    // Only run 2 remains — the whole-hunk accept must bulk-fill it, not
    // clobber the two runs already decided individually.
    await storeA.decide(hunkIdA, { kind: 'accept' })
    const docA = writtenMarkdown(invokeMock().mock.calls.length - 1)

    invokeMock().mockClear()
    setActivePinia(createPinia())
    const storeB = useReviewStore()
    vi.spyOn(useEditorStore(), 'loadChange').mockImplementation(() => {})
    storeB.enterReview(makeTab3(), change(prop3))
    const hunkIdB = storeB.hunks[0].id
    storeB.setDecidableRuns(hunkIdB, [0, 1, 2])

    await storeB.decideRun(hunkIdB, 0, 'accept')
    await storeB.decideRun(hunkIdB, 1, 'accept')
    await storeB.decideRun(hunkIdB, 2, 'accept')
    const docB = writtenMarkdown(invokeMock().mock.calls.length - 1)

    expect(docA).toBe(docB)
    expect(docA).toBe(prop3)
  })

  it('hunk-level accept after two individual Rejects preserves those rejects', async() => {
    const store = useReviewStore()
    vi.spyOn(useEditorStore(), 'loadChange').mockImplementation(() => {})
    store.enterReview(makeTab3(), change(prop3))
    const hunkId = store.hunks[0].id
    store.setDecidableRuns(hunkId, [0, 1, 2])

    await store.decideRun(hunkId, 0, 'reject')
    await store.decideRun(hunkId, 1, 'reject')
    // The bulk accept must only fill run 2 — runs 0 and 1 stay rejected,
    // so this must NOT equal the plain whole-hunk-accept document (prop3).
    await store.decide(hunkId, { kind: 'accept' })

    const doc = writtenMarkdown(invokeMock().mock.calls.length - 1)
    expect(doc).toBe('the quick fox jumps over the sleepy dog\ntwo\nthree')
    expect(doc).not.toBe(prop3)
  })

  it('a hunk with all decidable runs decided counts as decided in remainingCount', async() => {
    const store = useReviewStore()
    vi.spyOn(useEditorStore(), 'loadChange').mockImplementation(() => {})
    store.enterReview(makeTabMulti(), change(propMulti))
    expect(store.hunks.length).toBe(2)
    const [paragraphHunk, lineHunk] = store.hunks
    store.setDecidableRuns(paragraphHunk.id, [0, 1, 2])

    expect(store.remainingCount).toBe(2)

    await store.decideRun(paragraphHunk.id, 0, 'accept')
    await store.decideRun(paragraphHunk.id, 1, 'accept')
    await store.decideRun(paragraphHunk.id, 2, 'accept')

    expect(store.remainingCount).toBe(1)
    expect(store.active).toBe(true)
    expect(store.undecidedHunks.map((h) => h.id)).toEqual([lineHunk.id])
  })

  it('remainingCount stays in hunks — deciding one run of a 3-run hunk does not change it', async() => {
    const store = useReviewStore()
    store.enterReview(makeTab3(), change(prop3))
    const hunkId = store.hunks[0].id
    store.setDecidableRuns(hunkId, [0, 1, 2])

    expect(store.remainingCount).toBe(1)
    await store.decideRun(hunkId, 0, 'accept')
    expect(store.remainingCount).toBe(1)
  })

  it('finalize fires exactly once, on the last decidable run of the last hunk', async() => {
    const store = useReviewStore()
    const loadChangeSpy = vi
      .spyOn(useEditorStore(), 'loadChange')
      .mockImplementation(() => {})
    store.enterReview(makeTabMulti(), change(propMulti))
    const [paragraphHunk, lineHunk] = store.hunks
    store.setDecidableRuns(paragraphHunk.id, [0, 1, 2])

    await store.decide(lineHunk.id, { kind: 'accept' })
    expect(loadChangeSpy).not.toHaveBeenCalled()

    await store.decideRun(paragraphHunk.id, 0, 'accept')
    await store.decideRun(paragraphHunk.id, 1, 'accept')
    expect(loadChangeSpy).not.toHaveBeenCalled()

    await store.decideRun(paragraphHunk.id, 2, 'accept')

    expect(loadChangeSpy).toHaveBeenCalledTimes(1)
    expect(store.active).toBe(false)
  })

  it('seedSyntaxOnlyRuns is idempotent and never overwrites a real decision', async() => {
    // decideRun's write is debounced (US-011); this hunk never registers
    // decidableRuns, so it never finalizes either — advance past the
    // debounce window to observe the write.
    vi.useFakeTimers()
    try {
      const store = useReviewStore()
      store.enterReview(makeTab3(), change(prop3))
      const hunkId = store.hunks[0].id

      // Run 2 already carries a manual decision — the overlay must not clobber
      // it even if a later render's correlation puts index 2 in syntaxOnly.
      await store.decideRun(hunkId, 2, 'reject')
      await vi.advanceTimersByTimeAsync(400)
      expect(invokeMock()).toHaveBeenCalledTimes(1)

      store.seedSyntaxOnlyRuns(hunkId, [2])
      expect(store.runDecisions.get(hunkId)?.get(2)).toBe('reject')

      store.seedSyntaxOnlyRuns(hunkId, [0])
      expect(store.runDecisions.get(hunkId)?.get(0)).toBe('accept')

      // Re-seeding the same indexes is a no-op: no entries change, and no
      // write-back is triggered by a seed call alone.
      store.seedSyntaxOnlyRuns(hunkId, [0, 2])
      expect(store.runDecisions.get(hunkId)?.get(0)).toBe('accept')
      expect(store.runDecisions.get(hunkId)?.get(2)).toBe('reject')
      expect(invokeMock()).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('useReviewStore syntaxOnlyRunCount (US-010)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    invokeMock().mockResolvedValue(undefined)
  })

  it('is empty right after enterReview', () => {
    const store = useReviewStore()
    store.enterReview(makeTab3(), change(prop3))
    expect(store.syntaxOnlyRuns.size).toBe(0)
    expect(store.syntaxOnlyRunCount(store.hunks[0].id)).toBe(0)
  })

  it('reflects the indexes the latest correlation reported as syntax-only', () => {
    const store = useReviewStore()
    store.enterReview(makeTab3(), change(prop3))
    const hunkId = store.hunks[0].id

    store.seedSyntaxOnlyRuns(hunkId, [0, 2])

    expect(store.syntaxOnlyRunCount(hunkId)).toBe(2)
  })

  it('replaces rather than accumulates when a later render reports a different set', () => {
    const store = useReviewStore()
    store.enterReview(makeTab3(), change(prop3))
    const hunkId = store.hunks[0].id

    store.seedSyntaxOnlyRuns(hunkId, [0, 2])
    expect(store.syntaxOnlyRunCount(hunkId)).toBe(2)

    // The overlay re-correlates every render; a hunk that no longer has any
    // syntax-only runs must drop back down, not keep the stale count.
    store.seedSyntaxOnlyRuns(hunkId, [1])
    expect(store.syntaxOnlyRunCount(hunkId)).toBe(1)
  })

  it('resets on exitReview', () => {
    const store = useReviewStore()
    store.enterReview(makeTab3(), change(prop3))
    const hunkId = store.hunks[0].id
    store.seedSyntaxOnlyRuns(hunkId, [0])
    expect(store.syntaxOnlyRunCount(hunkId)).toBe(1)

    store.exitReview()

    expect(store.syntaxOnlyRuns.size).toBe(0)
  })

  it('resets on restartAgainstNewDisk', async() => {
    const store = useReviewStore()
    store.enterReview(makeTab(), change(prop))
    const hunkId = store.hunks[0].id
    store.seedSyntaxOnlyRuns(hunkId, [0])
    expect(store.syntaxOnlyRunCount(hunkId)).toBe(1)

    // A second external write that still differs from the frozen baseline,
    // so the restart re-diffs rather than exiting review outright.
    const prop2 = 'the slow fox leaps over\ntwo\nTHREE'
    await store.restartAgainstNewDisk(change(prop2))

    expect(store.active).toBe(true)
    expect(store.syntaxOnlyRuns.size).toBe(0)
  })
})
