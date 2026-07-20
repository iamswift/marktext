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

// Three replace hunks: h0 on line 0, h1 on line 4, h2 on line 6.
const base = 'one\ntwo\nthree\nfour\nfive\nsix\nseven'
const prop = 'ONE\ntwo\nthree\nfour\nFIVE\nsix\nSEVEN'

const makeTab = (): IFileState =>
  ({
    id: 'tab-1',
    filename: 'a.md',
    pathname: '/x/a.md',
    markdown: base,
    isSaved: true
  }) as unknown as IFileState

const change = {
  pathname: '/x/a.md',
  data: {
    markdown: prop,
    filename: 'a.md',
    lineEnding: 'lf',
    adjustLineEndingOnSave: false,
    trimTrailingNewline: 2,
    encoding: { encoding: 'utf8', isBom: false }
  }
}

const invokeMock = () => window.electron.ipcRenderer.invoke as Mock

describe('useReviewStore focusNext/focusPrev', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    invokeMock().mockResolvedValue(undefined)
  })

  it('starts on the first hunk and advances/wraps in document order', () => {
    const store = useReviewStore()
    store.enterReview(makeTab(), change)
    expect(store.activeHunkId).toBe('h0')

    store.focusNext()
    expect(store.activeHunkId).toBe('h1')
    store.focusNext()
    expect(store.activeHunkId).toBe('h2')
    store.focusNext()
    expect(store.activeHunkId).toBe('h0')
  })

  it('wraps backwards from the first hunk to the last', () => {
    const store = useReviewStore()
    store.enterReview(makeTab(), change)
    expect(store.activeHunkId).toBe('h0')

    store.focusPrev()
    expect(store.activeHunkId).toBe('h2')
    store.focusPrev()
    expect(store.activeHunkId).toBe('h1')
  })

  it('skips decided hunks and clears focus once none remain', async() => {
    const store = useReviewStore()
    vi.spyOn(useEditorStore(), 'loadChange').mockImplementation(() => {})
    store.enterReview(makeTab(), change)

    await store.decide('h1', { kind: 'reject' })
    // decide() already moved focus to the next undecided hunk (h0, since h1
    // is gone); focusNext from there should skip straight to h2.
    expect(store.activeHunkId).toBe('h0')
    store.focusNext()
    expect(store.activeHunkId).toBe('h2')

    await store.decide('h0', { kind: 'reject' })
    await store.decide('h2', { kind: 'reject' })
    // The review auto-finalizes once every hunk is decided.
    expect(store.active).toBe(false)
  })
})

describe('useReviewStore requestExit', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    invokeMock().mockResolvedValue(undefined)
  })

  it('prompts with Accept/Reject/Cancel when hunks are still undecided', () => {
    const store = useReviewStore()
    const editorStore = useEditorStore()
    const pushSpy = vi.spyOn(editorStore, 'pushTabNotification').mockImplementation(() => {})

    store.enterReview(makeTab(), change)
    store.requestExit()

    expect(pushSpy).toHaveBeenCalledTimes(1)
    const payload = pushSpy.mock.calls[0][0]
    expect(payload.tabId).toBe('tab-1')
    expect(payload.buttons?.map((b) => b.value)).toEqual(['accept', 'reject', 'cancel'])
  })

  it('accept in the exit prompt delegates to acceptAll', () => {
    const store = useReviewStore()
    const editorStore = useEditorStore()
    const acceptAllSpy = vi.spyOn(store, 'acceptAll').mockResolvedValue()
    let capturedAction: ((status?: unknown) => void) | undefined
    vi.spyOn(editorStore, 'pushTabNotification').mockImplementation((data) => {
      capturedAction = data.action
    })

    store.enterReview(makeTab(), change)
    store.requestExit()
    capturedAction?.('accept')

    expect(acceptAllSpy).toHaveBeenCalledTimes(1)
  })

  it('reject in the exit prompt delegates to rejectAll', () => {
    const store = useReviewStore()
    const editorStore = useEditorStore()
    const rejectAllSpy = vi.spyOn(store, 'rejectAll').mockResolvedValue()
    let capturedAction: ((status?: unknown) => void) | undefined
    vi.spyOn(editorStore, 'pushTabNotification').mockImplementation((data) => {
      capturedAction = data.action
    })

    store.enterReview(makeTab(), change)
    store.requestExit()
    capturedAction?.('reject')

    expect(rejectAllSpy).toHaveBeenCalledTimes(1)
  })

  it('cancel (or dismiss) leaves the review untouched', () => {
    const store = useReviewStore()
    const editorStore = useEditorStore()
    let capturedAction: ((status?: unknown) => void) | undefined
    vi.spyOn(editorStore, 'pushTabNotification').mockImplementation((data) => {
      capturedAction = data.action
    })

    store.enterReview(makeTab(), change)
    store.requestExit()
    capturedAction?.('cancel')

    expect(store.active).toBe(true)
    expect(store.decisions.size).toBe(0)
    expect(invokeMock()).not.toHaveBeenCalled()
  })

  it('is a no-op when review is not active', () => {
    const store = useReviewStore()
    const editorStore = useEditorStore()
    const pushSpy = vi.spyOn(editorStore, 'pushTabNotification').mockImplementation(() => {})

    store.requestExit()

    expect(pushSpy).not.toHaveBeenCalled()
  })
})
