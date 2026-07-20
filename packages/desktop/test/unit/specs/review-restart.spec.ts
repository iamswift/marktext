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

// Two replace hunks, kept non-adjacent (a context line on both sides of
// each) so they diff as separate hunks rather than merging into one run:
// h0 on line 0 ('one'->'ONE'), h1 on line 4 ('five'->'FIVE').
const base = 'one\ntwo\nthree\nfour\nfive\nsix\nseven'
const prop1 = 'ONE\ntwo\nthree\nfour\nFIVE\nsix\nseven'

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

describe('useReviewStore restartAgainstNewDisk', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    invokeMock().mockResolvedValue(undefined)
  })

  it('carries forward a decision whose hunk content recurs unchanged', async() => {
    const store = useReviewStore()
    vi.spyOn(useEditorStore(), 'loadChange').mockImplementation(() => {})

    store.enterReview(makeTab(), change(prop1))
    await store.decide('h0', { kind: 'reject' })
    invokeMock().mockClear()

    // A second external write: 'one'->'ONE' recurs verbatim (carry the
    // reject), a brand new 'three'->'THREE' hunk appears, and the
    // still-undecided 'five'->'FIVE' hunk is untouched.
    const prop2 = 'ONE\ntwo\nTHREE\nfour\nFIVE\nsix\nseven'
    await store.restartAgainstNewDisk(change(prop2))

    expect(store.active).toBe(true)
    expect(store.hunks).toHaveLength(3)
    expect(store.remainingCount).toBe(2)

    const carriedHunk = store.hunks.find((h) => h.baselineLines[0] === 'one')!
    expect(store.decisions.get(carriedHunk.id)).toEqual({ kind: 'reject' })
    const newHunk = store.hunks.find((h) => h.baselineLines[0] === 'three')!
    expect(store.decisions.has(newHunk.id)).toBe(false)

    // Reconciles disk immediately: the carried reject undoes 'ONE' again,
    // both undecided hunks stay proposed.
    expect(invokeMock()).toHaveBeenCalledTimes(1)
    expect(writtenMarkdown(0)).toBe('one\ntwo\nTHREE\nfour\nFIVE\nsix\nseven')
  })

  it('drops a decision whose hunk content changed', async() => {
    const store = useReviewStore()
    vi.spyOn(useEditorStore(), 'loadChange').mockImplementation(() => {})

    store.enterReview(makeTab(), change(prop1))
    await store.decide('h0', { kind: 'accept' })

    // Same line changed again, but to different text — a different
    // contentKey, so the old accept must not silently carry over.
    const prop2 = 'ONE-AGAIN\ntwo\nthree\nfour\nFIVE\nsix\nseven'
    await store.restartAgainstNewDisk(change(prop2))

    const changedHunk = store.hunks.find((h) => h.baselineLines[0] === 'one')!
    expect(store.decisions.has(changedHunk.id)).toBe(false)
    expect(store.remainingCount).toBe(2)
  })

  it('exits review when the new disk content now matches the baseline exactly', async() => {
    const store = useReviewStore()
    const loadChangeSpy = vi
      .spyOn(useEditorStore(), 'loadChange')
      .mockImplementation(() => {})

    store.enterReview(makeTab(), change(prop1))
    await store.restartAgainstNewDisk(change(base))

    expect(store.active).toBe(false)
    expect(loadChangeSpy).toHaveBeenCalledTimes(1)
    const payload = loadChangeSpy.mock.calls[0][0] as { data: { markdown: string; filename: string } }
    expect(payload.data.markdown).toBe(base)
    expect(payload.data.filename).toBe('a.md')
  })

  it('is a no-op when review is not active', async() => {
    const store = useReviewStore()
    await store.restartAgainstNewDisk(change(prop1))
    expect(store.hunks).toHaveLength(0)
  })
})

describe('useReviewStore handleExternalChangeDuringReview', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    invokeMock().mockResolvedValue(undefined)
  })

  it('prompts with Restart/Abandon buttons', () => {
    const store = useReviewStore()
    const editorStore = useEditorStore()
    const pushSpy = vi.spyOn(editorStore, 'pushTabNotification').mockImplementation(() => {})

    store.enterReview(makeTab(), change(prop1))
    store.handleExternalChangeDuringReview(change('ONE\ntwo\nTHREE\nFOUR\nfive'))

    expect(pushSpy).toHaveBeenCalledTimes(1)
    const payload = pushSpy.mock.calls[0][0]
    expect(payload.tabId).toBe('tab-1')
    expect(payload.buttons?.map((b) => b.value)).toEqual(['restart', 'abandon'])
  })

  it("'restart' delegates to restartAgainstNewDisk", () => {
    const store = useReviewStore()
    const editorStore = useEditorStore()
    const restartSpy = vi.spyOn(store, 'restartAgainstNewDisk').mockResolvedValue()
    let capturedAction: ((status?: unknown) => void) | undefined
    vi.spyOn(editorStore, 'pushTabNotification').mockImplementation((data) => {
      capturedAction = data.action
    })

    const secondChange = change('ONE\ntwo\nTHREE\nFOUR\nfive')
    store.enterReview(makeTab(), change(prop1))
    store.handleExternalChangeDuringReview(secondChange)
    capturedAction?.('restart')

    expect(restartSpy).toHaveBeenCalledWith(secondChange)
  })

  it("'abandon' exits review and loads the new change", () => {
    const store = useReviewStore()
    const editorStore = useEditorStore()
    const loadChangeSpy = vi.spyOn(editorStore, 'loadChange').mockImplementation(() => {})
    let capturedAction: ((status?: unknown) => void) | undefined
    vi.spyOn(editorStore, 'pushTabNotification').mockImplementation((data) => {
      capturedAction = data.action
    })

    store.enterReview(makeTab(), change(prop1))
    store.handleExternalChangeDuringReview(change('ONE\ntwo\nTHREE\nFOUR\nfive'))
    capturedAction?.('abandon')

    expect(store.active).toBe(false)
    expect(loadChangeSpy).toHaveBeenCalledTimes(1)
  })

  it('dismissing the prompt leaves the review untouched', () => {
    const store = useReviewStore()
    const editorStore = useEditorStore()
    let capturedAction: ((status?: unknown) => void) | undefined
    vi.spyOn(editorStore, 'pushTabNotification').mockImplementation((data) => {
      capturedAction = data.action
    })

    store.enterReview(makeTab(), change(prop1))
    store.handleExternalChangeDuringReview(change('ONE\ntwo\nTHREE\nFOUR\nfive'))
    capturedAction?.(false)

    expect(store.active).toBe(true)
    expect(store.hunks).toHaveLength(2)
  })
})

describe('useReviewStore handleFileDeleted', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    invokeMock().mockResolvedValue(undefined)
  })

  it('exits review and marks the tab unsaved', () => {
    const store = useReviewStore()
    const editorStore = useEditorStore()
    const tab = makeTab()
    editorStore.tabs = [tab] as unknown as typeof editorStore.tabs

    store.enterReview(tab, change(prop1))
    store.handleFileDeleted()

    expect(store.active).toBe(false)
    expect(tab.isSaved).toBe(false)
  })

  it('is a no-op when review is not active', () => {
    const store = useReviewStore()
    expect(() => store.handleFileDeleted()).not.toThrow()
    expect(store.active).toBe(false)
  })
})
