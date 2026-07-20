import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
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
import type { DiffHunk } from 'common/diff'

const hunkAt = (id: string, index: number, word: string): DiffHunk => ({
  id,
  index,
  type: 'replace',
  baselineStart: index,
  baselineLines: [`${word} old`],
  proposedStart: index,
  proposedLines: [`${word} new`],
  contentKey: `k-${id}`
})

// Three hunks so a single decision never triggers the finalize-and-exit path.
const seed = (): ReturnType<typeof useReviewStore> => {
  const store = useReviewStore()
  store.$patch({
    active: true,
    pathname: '/tmp/doc.md',
    baselineText: 'alpha old\n\nbeta old\n\ngamma old',
    hunks: [hunkAt('h0', 0, 'alpha'), hunkAt('h1', 2, 'beta'), hunkAt('h2', 4, 'gamma')],
    activeHunkId: 'h0'
  })
  return store
}

describe('review store undecide', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('remembers the hunk most recently decided', async() => {
    const store = seed()
    expect(store.lastDecidedHunkId).toBeNull()
    await store.decide('h1', { kind: 'accept' })
    expect(store.lastDecidedHunkId).toBe('h1')
    await store.decide('h0', { kind: 'reject' })
    expect(store.lastDecidedHunkId).toBe('h0')
  })

  it('restores a decided hunk to undecided and rewrites the file', async() => {
    const store = seed()
    const invoke = window.electron.ipcRenderer.invoke as Mock
    await store.decide('h1', { kind: 'accept' })
    const writesAfterDecide = invoke.mock.calls.length

    await store.undecide('h1')
    expect(store.decisions.has('h1')).toBe(false)
    expect(store.remainingCount).toBe(3)
    // The resolved document changed, so it has to reach disk.
    expect(invoke.mock.calls.length).toBeGreaterThan(writesAfterDecide)
  })

  it('clears the memory of the last decision once it is undone', async() => {
    const store = seed()
    await store.decide('h1', { kind: 'accept' })
    await store.undecide('h1')
    expect(store.lastDecidedHunkId).toBeNull()
  })

  it('focuses the restored hunk so the next keystroke acts on it', async() => {
    const store = seed()
    await store.decide('h1', { kind: 'accept' })
    await store.undecide('h1')
    expect(store.activeHunkId).toBe('h1')
  })

  it('ignores a hunk that was never decided', async() => {
    const store = seed()
    const invoke = window.electron.ipcRenderer.invoke as Mock
    const before = invoke.mock.calls.length
    await store.undecide('h2')
    expect(invoke.mock.calls.length).toBe(before)
  })

  it('forgets the last decision after a bulk decision', async() => {
    // Keep all / Undo all decide everything at once, so there is no single
    // change left to single out.
    const store = seed()
    await store.decide('h1', { kind: 'accept' })
    await store.acceptAll()
    expect(store.lastDecidedHunkId).toBeNull()
  })

  it('forgets the last decision when the review ends', async() => {
    const store = seed()
    await store.decide('h1', { kind: 'accept' })
    store.exitReview()
    expect(store.lastDecidedHunkId).toBeNull()
  })
})
