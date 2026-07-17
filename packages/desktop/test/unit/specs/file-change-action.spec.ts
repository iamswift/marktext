import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.hoisted(() => {
  const w = globalThis as unknown as {
    window?: {
      path?: { sep: string; dirname: (p: string) => string }
      fileUtils?: { isSamePathSync: (a: string, b: string) => boolean }
      electron?: { ipcRenderer: { send: (...a: unknown[]) => void; on: Mock } }
    }
  }
  w.window ??= {}
  w.window.path ??= { sep: '/', dirname: (p: string) => p }
  w.window.fileUtils ??= { isSamePathSync: (a, b) => a === b }
  w.window.electron ??= { ipcRenderer: { send: () => {}, on: vi.fn() } }
})

vi.mock('@/services/notification', () => ({
  default: { notify: vi.fn(), name: 'notify' }
}))
vi.mock('@/store/bufferedState', () => ({ debouncedSendBufferedState: vi.fn() }))

import { useEditorStore } from '@/store/editor'
import { usePreferencesStore } from '@/store/preferences'
import { useReviewStore } from '@/store/review'
import type { FileNotification } from '@shared/types/files'

type NotificationPayload = FileNotification & { tabId: string }

describe('useEditorStore LISTEN_FOR_FILE_CHANGE — fileChangeAction matrix', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ;(window.electron.ipcRenderer.on as Mock).mockReset()
  })

  const setup = (options: {
    fileChangeAction: 'ask' | 'review' | 'reload'
    autoSave?: boolean
    isSaved?: boolean
    enterReviewResult?: boolean
  }) => {
    const store = useEditorStore()
    const preferencesStore = usePreferencesStore()
    const reviewStore = useReviewStore()

    preferencesStore.fileChangeAction = options.fileChangeAction
    preferencesStore.autoSave = options.autoSave ?? false

    const tab = {
      id: 'tab-1',
      filename: 'a.md',
      pathname: '/x/a.md',
      markdown: 'hello',
      isSaved: options.isSaved ?? true
    }
    store.tabs = [tab] as unknown as typeof store.tabs
    store.tabIdToIndex = { 'tab-1': 0 }

    const notifySpy = vi
      .spyOn(store, 'pushTabNotification')
      .mockImplementation(() => {})
    const loadChangeSpy = vi.spyOn(store, 'loadChange').mockImplementation(() => {})
    const enterReviewSpy = vi
      .spyOn(reviewStore, 'enterReview')
      .mockReturnValue(options.enterReviewResult ?? true)

    store.LISTEN_FOR_FILE_CHANGE()
    const onMock = window.electron.ipcRenderer.on as Mock
    const call = onMock.mock.calls.find((c) => c[0] === 'mt::update-file')!
    const handler = call[1] as (e: unknown, payload: unknown) => void
    const fire = (markdown = 'changed on disk') =>
      handler(null, { type: 'change', change: { pathname: '/x/a.md', data: { markdown } } })

    return { store, tab, notifySpy, loadChangeSpy, enterReviewSpy, fire }
  }

  it("'ask' offers Review and Reload buttons", () => {
    const { notifySpy, fire } = setup({ fileChangeAction: 'ask' })
    fire()
    expect(notifySpy).toHaveBeenCalledTimes(1)
    const payload = notifySpy.mock.calls[0][0] as NotificationPayload
    expect(payload.buttons?.map((b) => b.value)).toEqual(['review', 'reload'])
  })

  it("'ask' review button enters review mode", () => {
    const { notifySpy, enterReviewSpy, loadChangeSpy, fire } = setup({
      fileChangeAction: 'ask'
    })
    fire()
    const payload = notifySpy.mock.calls[0][0] as NotificationPayload
    payload.action('review')
    expect(enterReviewSpy).toHaveBeenCalledTimes(1)
    expect(loadChangeSpy).not.toHaveBeenCalled()
  })

  it("'ask' reload button reloads from disk", () => {
    const { notifySpy, enterReviewSpy, loadChangeSpy, fire } = setup({
      fileChangeAction: 'ask'
    })
    fire()
    const payload = notifySpy.mock.calls[0][0] as NotificationPayload
    payload.action('reload')
    expect(loadChangeSpy).toHaveBeenCalledTimes(1)
    expect(enterReviewSpy).not.toHaveBeenCalled()
  })

  it("'ask' is not bypassed by auto-save on a saved tab", () => {
    const { notifySpy, loadChangeSpy, fire } = setup({
      fileChangeAction: 'ask',
      autoSave: true,
      isSaved: true
    })
    fire()
    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(loadChangeSpy).not.toHaveBeenCalled()
  })

  it("'review' enters review mode directly without a notification", () => {
    const { notifySpy, enterReviewSpy, fire } = setup({ fileChangeAction: 'review' })
    fire()
    expect(enterReviewSpy).toHaveBeenCalledTimes(1)
    expect(notifySpy).not.toHaveBeenCalled()
  })

  it("'review' falls back to reload when there is no line-level diff", () => {
    const { enterReviewSpy, loadChangeSpy, fire } = setup({
      fileChangeAction: 'review',
      enterReviewResult: false
    })
    fire()
    expect(enterReviewSpy).toHaveBeenCalledTimes(1)
    expect(loadChangeSpy).toHaveBeenCalledTimes(1)
  })

  it("'review' passes the tab's actual dirty state as wasUnsaved (FR-3)", () => {
    const { enterReviewSpy, fire } = setup({ fileChangeAction: 'review', isSaved: false })
    fire()
    expect(enterReviewSpy.mock.calls[0][2]).toBe(true)
  })

  it(
    "'ask' review button passes wasUnsaved from before the notification " +
      'forced tab.isSaved false, not the (now stale) mutated value',
    () => {
      const { notifySpy, enterReviewSpy, fire } = setup({
        fileChangeAction: 'ask',
        isSaved: true
      })
      fire()
      const payload = notifySpy.mock.calls[0][0] as NotificationPayload
      payload.action('review')
      // The tab really was saved when the external change landed — even
      // though the 'ask' handler already flipped tab.isSaved to false by
      // the time the user clicks "Review" — so the banner must not fire.
      expect(enterReviewSpy.mock.calls[0][2]).toBe(false)
    }
  )

  it("'reload' keeps the legacy confirm notification", () => {
    const { notifySpy, fire } = setup({ fileChangeAction: 'reload' })
    fire()
    const payload = notifySpy.mock.calls[0][0] as NotificationPayload
    expect(payload.showConfirm).toBe(true)
    expect(payload.buttons).toBeUndefined()
  })

  it("'reload' with auto-save silently reloads a saved tab", () => {
    const { notifySpy, loadChangeSpy, fire } = setup({
      fileChangeAction: 'reload',
      autoSave: true,
      isSaved: true
    })
    fire()
    expect(loadChangeSpy).toHaveBeenCalledTimes(1)
    expect(notifySpy).not.toHaveBeenCalled()
  })
})
