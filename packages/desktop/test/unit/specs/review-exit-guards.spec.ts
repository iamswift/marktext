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
      marktext?: unknown
    }
  }
  w.window ??= {}
  w.window.path ??= { sep: '/', dirname: (p: string) => p }
  w.window.fileUtils ??= { isSamePathSync: (a, b) => a === b }
  w.window.electron ??= {
    ipcRenderer: { send: () => {}, on: vi.fn(), invoke: vi.fn() }
  }
  w.window.marktext ??= { env: { windowId: 1 } }
})

vi.mock('@/services/notification', () => ({
  default: { notify: vi.fn(), name: 'notify' }
}))
vi.mock('@/store/bufferedState', () => ({ debouncedSendBufferedState: vi.fn() }))

import { useEditorStore } from '@/store/editor'
import { usePreferencesStore } from '@/store/preferences'
import { useReviewStore } from '@/store/review'
import type { IFileState } from '@shared/types/files'

const base = 'one\ntwo\nthree'
const prop = 'ONE\ntwo\nthree'

const makeTab = (id: string): IFileState =>
  ({
    id,
    filename: `${id}.md`,
    pathname: `/x/${id}.md`,
    markdown: base,
    isSaved: true
  }) as unknown as IFileState

const change = {
  pathname: '/x/tab-1.md',
  data: {
    markdown: prop,
    filename: 'tab-1.md',
    lineEnding: 'lf',
    adjustLineEndingOnSave: false,
    trimTrailingNewline: 2,
    encoding: { encoding: 'utf8', isBom: false }
  }
}

describe('source-mode toggle guard against an active review', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ;(window.electron.ipcRenderer.invoke as Mock).mockResolvedValue(undefined)
  })

  it('requests exit instead of entering source mode while reviewing the current tab', () => {
    const editorStore = useEditorStore()
    const reviewStore = useReviewStore()
    const preferencesStore = usePreferencesStore()
    const tab = makeTab('tab-1')
    editorStore.currentFile = tab
    reviewStore.enterReview(tab, change)

    const requestExitSpy = vi.spyOn(reviewStore, 'requestExit').mockImplementation(() => {})
    const before = preferencesStore.sourceCode

    preferencesStore.TOGGLE_VIEW_MODE('sourceCode')

    expect(requestExitSpy).toHaveBeenCalledTimes(1)
    expect(preferencesStore.sourceCode).toBe(before)
  })

  it('toggles normally when no review is active', () => {
    const preferencesStore = usePreferencesStore()
    const before = preferencesStore.sourceCode

    preferencesStore.TOGGLE_VIEW_MODE('sourceCode')

    expect(preferencesStore.sourceCode).toBe(!before)
  })

  it('toggles normally when a review is active on a different tab', () => {
    const editorStore = useEditorStore()
    const reviewStore = useReviewStore()
    const preferencesStore = usePreferencesStore()
    const reviewingTab = makeTab('tab-1')
    reviewStore.enterReview(reviewingTab, change)
    editorStore.currentFile = makeTab('tab-2')

    const before = preferencesStore.sourceCode
    preferencesStore.TOGGLE_VIEW_MODE('sourceCode')

    expect(preferencesStore.sourceCode).toBe(!before)
  })

  it('other view entries are unaffected by an active review', () => {
    const editorStore = useEditorStore()
    const reviewStore = useReviewStore()
    const preferencesStore = usePreferencesStore()
    const tab = makeTab('tab-1')
    editorStore.currentFile = tab
    reviewStore.enterReview(tab, change)

    const before = preferencesStore.typewriter
    preferencesStore.TOGGLE_VIEW_MODE('typewriter')

    expect(preferencesStore.typewriter).toBe(!before)
  })
})

describe('CLOSE_TAB guard against an active review', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ;(window.electron.ipcRenderer.invoke as Mock).mockResolvedValue(undefined)
  })

  it('requests exit instead of closing the reviewing tab', () => {
    const editorStore = useEditorStore()
    const reviewStore = useReviewStore()
    const tab = makeTab('tab-1')
    editorStore.tabs = [tab] as unknown as typeof editorStore.tabs
    editorStore.tabIdToIndex = { 'tab-1': 0 }
    reviewStore.enterReview(tab, change)

    const requestExitSpy = vi.spyOn(reviewStore, 'requestExit').mockImplementation(() => {})
    const forceCloseSpy = vi.spyOn(editorStore, 'FORCE_CLOSE_TAB').mockImplementation(() => {})

    editorStore.CLOSE_TAB(tab)

    expect(requestExitSpy).toHaveBeenCalledTimes(1)
    expect(forceCloseSpy).not.toHaveBeenCalled()
  })

  it('closes normally when the tab is not under review, even mid-review on another tab', () => {
    const editorStore = useEditorStore()
    const reviewStore = useReviewStore()
    const reviewingTab = makeTab('tab-1')
    const otherTab = makeTab('tab-2')
    editorStore.tabs = [reviewingTab, otherTab] as unknown as typeof editorStore.tabs
    editorStore.tabIdToIndex = { 'tab-1': 0, 'tab-2': 1 }
    reviewStore.enterReview(reviewingTab, change)

    const forceCloseSpy = vi.spyOn(editorStore, 'FORCE_CLOSE_TAB').mockImplementation(() => {})

    editorStore.CLOSE_TAB(otherTab)

    expect(forceCloseSpy).toHaveBeenCalledWith(otherTab)
  })
})
