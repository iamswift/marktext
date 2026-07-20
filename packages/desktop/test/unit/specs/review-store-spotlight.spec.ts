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

const hunkAt = (id: string, index: number, line: string): DiffHunk => ({
  id,
  index,
  type: 'replace',
  baselineStart: index,
  baselineLines: [`${line} old`],
  proposedStart: index,
  proposedLines: [`${line} new`],
  contentKey: `k-${id}`
})

const seed = (): ReturnType<typeof useReviewStore> => {
  const store = useReviewStore()
  store.$patch({
    active: true,
    pathname: '/tmp/doc.md',
    baselineText: 'alpha old\n\nbeta old',
    hunks: [hunkAt('h0', 0, 'alpha'), hunkAt('h1', 2, 'beta')],
    activeHunkId: 'h0'
  })
  return store
}

describe('review store spotlight', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('starts with nothing spotlighted', () => {
    expect(seed().spotlightHunkId).toBeNull()
  })

  it('sets and clears the spotlighted hunk', () => {
    const store = seed()
    store.setSpotlight('h1')
    expect(store.spotlightHunkId).toBe('h1')
    store.setSpotlight(null)
    expect(store.spotlightHunkId).toBeNull()
  })

  it('points the keyboard cursor at a spotlighted undecided hunk without scrolling to it', () => {
    // The card the user clicked is already beside its paragraph, so centring it
    // would yank the page out from under the cursor.
    const store = seed()
    store.setSpotlight('h1')
    expect(store.activeHunkId).toBe('h1')
    expect(store.suppressNextFocusScroll).toBe(true)
  })

  it('leaves the keyboard cursor alone when the spotlighted hunk is already active', () => {
    const store = seed()
    store.setSpotlight('h0')
    expect(store.activeHunkId).toBe('h0')
    expect(store.suppressNextFocusScroll).toBe(false)
  })

  it('leaves the keyboard cursor alone for a decided hunk', () => {
    // activeHunkId must always point at something still decidable.
    const store = seed()
    store.decisions.set('h1', { kind: 'accept' })
    store.setSpotlight('h1')
    expect(store.spotlightHunkId).toBe('h1')
    expect(store.activeHunkId).toBe('h0')
    expect(store.suppressNextFocusScroll).toBe(false)
  })

  it('clears the spotlight when the spotlighted hunk is decided and melts away', async() => {
    const store = seed()
    store.setSpotlight('h1')
    await store.decide('h1', { kind: 'accept' })
    expect(store.spotlightHunkId).toBeNull()
  })

  it('keeps the spotlight when a different hunk is decided', async() => {
    const store = seed()
    store.setSpotlight('h1')
    await store.decide('h0', { kind: 'accept' })
    expect(store.spotlightHunkId).toBe('h1')
  })

  it('resets the spotlight when the review ends', () => {
    const store = seed()
    store.setSpotlight('h1')
    store.exitReview()
    expect(store.spotlightHunkId).toBeNull()
    expect(store.suppressNextFocusScroll).toBe(false)
  })

  it('does not carry a spotlight into a new review', () => {
    // Hunk ids are re-keyed per review, so a stale spotlight would land on an
    // unrelated hunk.
    const store = seed()
    store.setSpotlight('h1')
    store.enterReview(
      { id: 'tab1', markdown: 'the priting industry', isSaved: true } as never,
      { pathname: '/tmp/doc.md', data: { markdown: 'the printing industry' } } as never
    )
    expect(store.spotlightHunkId).toBeNull()
  })
})
