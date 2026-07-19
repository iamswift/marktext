import { describe, expect, it, vi, type Mock } from 'vitest'
import { computed, nextTick } from 'vue'
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

const hunk: DiffHunk = {
  id: 'h1',
  index: 0,
  type: 'replace',
  baselineStart: 0,
  baselineLines: ['keep this intro then everything here is completely different wording'],
  proposedStart: 0,
  proposedLines: ['keep this intro then a totally fresh sentence appears instead'],
  contentKey: 'k1'
}

describe('viewFor reactivity', () => {
  // The overlay reads viewFor inside a computed. If toggleView does not
  // invalidate that computed, the toggle button silently does nothing.
  it('a computed reading viewFor re-evaluates after toggleView', async() => {
    setActivePinia(createPinia())
    const store = useReviewStore()
    store.$patch({ active: true, hunks: [hunk] })

    const view = computed(() => store.viewFor('h1'))
    expect(view.value).toBe('stacked')

    store.toggleView('h1')
    await nextTick()
    expect(view.value).toBe('inline')
  })
})
