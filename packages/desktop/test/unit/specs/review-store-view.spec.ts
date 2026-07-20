import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The review store pulls in the editor store, which reads preload-injected
// globals at import time. Same harness as review-store-decisions.spec.ts.
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
import { usePreferencesStore } from '@/store/preferences'
import type { DiffHunk } from 'common/diff'

const smallHunk: DiffHunk = {
  id: 'h0',
  index: 0,
  type: 'replace',
  baselineStart: 0,
  baselineLines: ['the priting industry'],
  proposedStart: 0,
  proposedLines: ['the printing industry'],
  contentKey: 'k0'
}

// One contiguous rewrite sharing no words with its replacement, so the
// classifier stacks it on size rather than on structure.
const bigHunk: DiffHunk = {
  id: 'h1',
  index: 1,
  type: 'replace',
  baselineStart: 5,
  baselineLines: ['keep this intro then everything here is completely different wording'],
  proposedStart: 5,
  proposedLines: ['keep this intro then a totally fresh sentence appears instead'],
  contentKey: 'k1'
}

describe('review store view selection', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    useReviewStore().$patch({ active: true, hunks: [smallHunk, bigHunk] })
  })

  it('viewFor follows the classifier when the preference is auto', () => {
    const store = useReviewStore()
    usePreferencesStore().$patch({ reviewDiffLayout: 'auto' })
    expect(store.viewFor('h0')).toBe('inline')
    expect(store.viewFor('h1')).toBe('stacked')
  })

  it('a non-auto preference forces every hunk', () => {
    const store = useReviewStore()
    const prefs = usePreferencesStore()

    prefs.$patch({ reviewDiffLayout: 'stacked' })
    expect(store.viewFor('h0')).toBe('stacked')
    expect(store.viewFor('h1')).toBe('stacked')

    prefs.$patch({ reviewDiffLayout: 'inline' })
    expect(store.viewFor('h0')).toBe('inline')
    expect(store.viewFor('h1')).toBe('inline')
  })

  it('toggleView overrides the rule per hunk', () => {
    const store = useReviewStore()
    usePreferencesStore().$patch({ reviewDiffLayout: 'auto' })

    store.toggleView('h1')
    expect(store.viewFor('h1')).toBe('inline')
    store.toggleView('h1')
    expect(store.viewFor('h1')).toBe('stacked')
    // the other hunk is untouched by its neighbour's override
    expect(store.viewFor('h0')).toBe('inline')
  })

  it('a hand override wins over the preference', () => {
    const store = useReviewStore()
    usePreferencesStore().$patch({ reviewDiffLayout: 'stacked' })

    store.toggleView('h0')
    expect(store.viewFor('h0')).toBe('inline')
    // and still wins when the preference flips to the opposite forcing value
    usePreferencesStore().$patch({ reviewDiffLayout: 'inline' })
    store.toggleView('h0')
    expect(store.viewFor('h0')).toBe('stacked')
  })

  it('viewFor returns stacked for an unknown hunk id (safe fallback)', () => {
    expect(useReviewStore().viewFor('nope')).toBe('stacked')
  })

  it('exitReview clears hand overrides', () => {
    const store = useReviewStore()
    usePreferencesStore().$patch({ reviewDiffLayout: 'auto' })

    store.toggleView('h0')
    expect(store.viewFor('h0')).toBe('stacked')

    store.exitReview()
    store.$patch({ active: true, hunks: [smallHunk, bigHunk] })
    expect(store.viewFor('h0')).toBe('inline')
  })

  it('entering a new review does not inherit overrides from the previous one', () => {
    const store = useReviewStore()
    usePreferencesStore().$patch({ reviewDiffLayout: 'auto' })

    store.toggleView('h0')
    expect(store.viewFor('h0')).toBe('stacked')

    const entered = store.enterReview(
      { id: 'tab1', markdown: 'the priting industry', isSaved: true } as never,
      { pathname: '/tmp/doc.md', data: { markdown: 'the printing industry' } } as never
    )
    expect(entered).toBe(true)
    // hunk ids re-key on entry; a stale override must not leak onto the new set
    for (const hunk of store.hunks) {
      expect(store.viewFor(hunk.id)).toBe('inline')
    }
  })
})
