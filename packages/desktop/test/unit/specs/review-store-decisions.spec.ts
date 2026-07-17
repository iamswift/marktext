import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
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

// Two replace hunks: h0 on line 0, h1 on line 3.
const base = 'one\ntwo\nthree\nfour\nfive'
const prop = 'ONE\ntwo\nthree\nFOUR\nfive'

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
const writtenMarkdown = (call: number) => invokeMock().mock.calls[call][2] as string

describe('useReviewStore decisions (FR-10 write-back)', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    invokeMock().mockResolvedValue(undefined)
  })

  it('rejecting one hunk keeps undecided hunks in their proposed form on disk', async() => {
    const store = useReviewStore()
    store.enterReview(makeTab(), change)
    await store.decide('h0', { kind: 'reject' })

    expect(invokeMock()).toHaveBeenCalledTimes(1)
    expect(invokeMock().mock.calls[0][0]).toBe('mt::review-write-file')
    expect(invokeMock().mock.calls[0][1]).toBe('/x/a.md')
    // h0 rejected → baseline line; h1 undecided → proposed line stays.
    expect(writtenMarkdown(0)).toBe('one\ntwo\nthree\nFOUR\nfive')
  })

  it('finalizes into loadChange when the last hunk is decided', async() => {
    const store = useReviewStore()
    const loadChangeSpy = vi
      .spyOn(useEditorStore(), 'loadChange')
      .mockImplementation(() => {})

    store.enterReview(makeTab(), change)
    await store.decide('h1', { kind: 'reject' })
    expect(store.active).toBe(true)
    expect(loadChangeSpy).not.toHaveBeenCalled()

    await store.decide('h0', { kind: 'reject' })
    expect(writtenMarkdown(1)).toBe(base)
    expect(store.active).toBe(false)
    expect(loadChangeSpy).toHaveBeenCalledTimes(1)
    const payload = loadChangeSpy.mock.calls[0][0] as { data: { markdown: string } }
    expect(payload.data.markdown).toBe(base)
  })

  it('acceptAll writes once and finalizes to the proposed document', async() => {
    const store = useReviewStore()
    const loadChangeSpy = vi
      .spyOn(useEditorStore(), 'loadChange')
      .mockImplementation(() => {})

    store.enterReview(makeTab(), change)
    await store.acceptAll()

    expect(invokeMock()).toHaveBeenCalledTimes(1)
    expect(writtenMarkdown(0)).toBe(prop)
    expect(store.active).toBe(false)
    expect(loadChangeSpy).toHaveBeenCalledTimes(1)
  })

  it('applies an edit decision verbatim', async() => {
    const store = useReviewStore()
    vi.spyOn(useEditorStore(), 'loadChange').mockImplementation(() => {})

    store.enterReview(makeTab(), change)
    await store.confirmEdit('h0', 'EDITED')
    await store.decide('h1', { kind: 'reject' })

    expect(writtenMarkdown(1)).toBe('EDITED\ntwo\nthree\nfour\nfive')
  })

  it('keeps decisions and reports an error when the write fails', async() => {
    const store = useReviewStore()
    const loadChangeSpy = vi
      .spyOn(useEditorStore(), 'loadChange')
      .mockImplementation(() => {})
    invokeMock().mockRejectedValue(new Error('EBUSY: locked'))

    store.enterReview(makeTab(), change)
    await store.decide('h0', { kind: 'accept' })

    expect(store.decisions.has('h0')).toBe(true)
    expect(store.writeState).toBe('error')
    expect(store.writeError).toContain('EBUSY')
    expect(store.active).toBe(true)
    expect(loadChangeSpy).not.toHaveBeenCalled()

    invokeMock().mockResolvedValue(undefined)
    await store.retryWrite()
    expect(store.writeState).toBe('idle')
    expect(store.active).toBe(true)
  })

  it('a failed write on the last decision finalizes after a successful retry', async() => {
    const store = useReviewStore()
    const loadChangeSpy = vi
      .spyOn(useEditorStore(), 'loadChange')
      .mockImplementation(() => {})

    store.enterReview(makeTab(), change)
    await store.decide('h0', { kind: 'accept' })
    invokeMock().mockRejectedValue(new Error('EPERM'))
    await store.decide('h1', { kind: 'reject' })
    expect(store.active).toBe(true)
    expect(loadChangeSpy).not.toHaveBeenCalled()

    invokeMock().mockResolvedValue(undefined)
    await store.retryWrite()
    expect(store.active).toBe(false)
    expect(loadChangeSpy).toHaveBeenCalledTimes(1)
  })

  it('ignores duplicate decisions for the same hunk', async() => {
    const store = useReviewStore()
    vi.spyOn(useEditorStore(), 'loadChange').mockImplementation(() => {})

    store.enterReview(makeTab(), change)
    await store.decide('h0', { kind: 'reject' })
    await store.decide('h0', { kind: 'accept' })

    expect(invokeMock()).toHaveBeenCalledTimes(1)
    expect(store.decisions.get('h0')).toEqual({ kind: 'reject' })
  })
})

describe('review write-back EOL/BOM round-trip', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-review-roundtrip-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('preserves CRLF and BOM through write and reload', async() => {
    const { writeMarkdownFile, loadMarkdownFile } = await import(
      'main_renderer/filesystem/markdown'
    )
    const target = path.join(dir, 'roundtrip.md')
    const resolved = 'ONE\ntwo\nthree\nfour\nfive\n'

    await writeMarkdownFile(target, resolved, {
      encoding: { encoding: 'utf8', isBom: true },
      lineEnding: 'crlf',
      adjustLineEndingOnSave: true
    } as Parameters<typeof writeMarkdownFile>[2])

    const raw = fs.readFileSync(target)
    expect([raw[0], raw[1], raw[2]]).toEqual([0xef, 0xbb, 0xbf])
    expect(raw.toString('utf8')).toContain('\r\n')

    const loaded = await loadMarkdownFile(target, 'lf', true, 2, false)
    expect(loaded.lineEnding).toBe('crlf')
    expect(loaded.encoding.isBom).toBe(true)
    // Content matches modulo the trailing-newline policy applied on load.
    expect(loaded.markdown.replace(/\n+$/, '')).toBe(resolved.replace(/\n+$/, ''))
  })
})
