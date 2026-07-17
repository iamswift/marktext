import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { computeHunks, normalizeText, type DiffHunk } from 'common/diff'
import { resolveDocument, type HunkDecision } from 'common/diff/resolve'
import { useEditorStore } from './editor'
import type { IFileState, LineEnding, SaveOptions } from '@shared/types/files'

// Serializes review write-backs: each write covers the full latest decision
// set, so later writes strictly supersede earlier ones — they must not race.
let writeChain: Promise<void> = Promise.resolve()

/**
 * The parsed on-disk document from an mt::update-file change event. Captured
 * at review entry so write-backs re-apply the file's current EOL/BOM style
 * rather than the (possibly stale) tab metadata.
 */
export interface ReviewChangeData {
  markdown: string
  filename?: string
  lineEnding?: LineEnding | string
  adjustLineEndingOnSave?: boolean
  trimTrailingNewline?: number
  encoding?: IFileState['encoding']
  isMixedLineEndings?: boolean
}

export interface ReviewChangePayload {
  pathname: string
  data: ReviewChangeData
}

export type ReviewWriteState = 'idle' | 'writing' | 'error'

interface ReviewState {
  active: boolean
  tabId: string | null
  pathname: string | null
  /** LF-normalized in-editor content frozen at review entry (FR-2/FR-3). */
  baselineText: string
  /** LF-normalized on-disk content the external tool wrote. */
  proposedText: string
  /** FR-3: the review bar states when the baseline includes unsaved edits. */
  baselineWasUnsaved: boolean
  hunks: DiffHunk[]
  decisions: Map<string, HunkDecision>
  activeHunkId: string | null
  editingHunkId: string | null
  diskMeta: ReviewChangeData | null
  writeState: ReviewWriteState
  writeError: string | null
}

const initialState = (): ReviewState => ({
  active: false,
  tabId: null,
  pathname: null,
  baselineText: '',
  proposedText: '',
  baselineWasUnsaved: false,
  hunks: [],
  decisions: new Map(),
  activeHunkId: null,
  editingHunkId: null,
  diskMeta: null,
  writeState: 'idle',
  writeError: null
})

export const useReviewStore = defineStore('review', {
  state: initialState,

  getters: {
    undecidedHunks: (state): DiffHunk[] =>
      state.hunks.filter((hunk) => !state.decisions.has(hunk.id)),
    remainingCount(): number {
      return this.undecidedHunks.length
    }
  },

  actions: {
    /**
     * Starts a review of the on-disk change against the tab's current content.
     * Returns false when there is no line-level difference (e.g. an EOL-only
     * change) — the caller should fall back to a plain reload in that case.
     */
    enterReview(tab: IFileState, change: ReviewChangePayload): boolean {
      const hunks = computeHunks(tab.markdown, change.data.markdown)
      if (hunks.length === 0) {
        return false
      }

      this.$patch({
        active: true,
        tabId: tab.id,
        pathname: change.pathname,
        baselineText: tab.markdown,
        proposedText: change.data.markdown,
        baselineWasUnsaved: !tab.isSaved,
        hunks,
        decisions: new Map(),
        activeHunkId: hunks[0].id,
        editingHunkId: null,
        diskMeta: change.data,
        writeState: 'idle',
        writeError: null
      })
      return true
    },

    exitReview(): void {
      Object.assign(this, initialState())
    },

    /**
     * Records a decision and writes the resolved document. The decision is
     * kept even when the write fails (FR-16) — retryWrite re-attempts the
     * same resolution. Finalizes the review after the last decision lands.
     */
    async decide(hunkId: string, decision: HunkDecision): Promise<void> {
      if (!this.active || this.decisions.has(hunkId)) {
        return
      }
      const hunk = this.hunks.find((h) => h.id === hunkId)
      if (!hunk) {
        return
      }

      this.decisions.set(hunkId, decision)
      if (this.editingHunkId === hunkId) {
        this.editingHunkId = null
      }
      if (this.activeHunkId === hunkId) {
        this.activeHunkId = this.undecidedHunks[0]?.id ?? null
      }

      await this._writeResolved()
      this._maybeFinalize()
    },

    async acceptAll(): Promise<void> {
      await this._decideRemaining({ kind: 'accept' })
    },

    async rejectAll(): Promise<void> {
      await this._decideRemaining({ kind: 'reject' })
    },

    beginEdit(hunkId: string): void {
      if (this.active && !this.decisions.has(hunkId)) {
        this.editingHunkId = hunkId
        this.activeHunkId = hunkId
      }
    },

    cancelEdit(): void {
      this.editingHunkId = null
    },

    async confirmEdit(hunkId: string, text: string): Promise<void> {
      await this.decide(hunkId, { kind: 'edit', lines: normalizeText(text).split('\n') })
    },

    /** Re-attempts the write after a failure, decisions intact. */
    async retryWrite(): Promise<void> {
      if (!this.active || this.writeState !== 'error') {
        return
      }
      await this._writeResolved()
      this._maybeFinalize()
    },

    async _decideRemaining(decision: HunkDecision): Promise<void> {
      if (!this.active || this.remainingCount === 0) {
        return
      }
      for (const hunk of this.undecidedHunks) {
        this.decisions.set(hunk.id, decision)
      }
      this.editingHunkId = null
      this.activeHunkId = null
      await this._writeResolved()
      this._maybeFinalize()
    },

    _resolvedDocument(): string {
      return resolveDocument(this.baselineText, this.hunks, this.decisions)
    },

    _saveOptions(): SaveOptions {
      // Pinia state is a reactive Proxy; nested objects (diskMeta.encoding)
      // are lazily wrapped too. Electron's IPC uses structured clone, which
      // rejects Proxies ("An object could not be cloned"), so unwrap to the
      // raw target before it crosses the bridge.
      const diskMeta = this.diskMeta ? toRaw(this.diskMeta) : null
      return {
        encoding: diskMeta?.encoding,
        lineEnding: diskMeta?.lineEnding as SaveOptions['lineEnding'],
        adjustLineEndingOnSave: diskMeta?.adjustLineEndingOnSave,
        trimTrailingNewline: diskMeta?.trimTrailingNewline
      }
    },

    async _writeResolved(): Promise<void> {
      const { pathname } = this
      if (!pathname) {
        return
      }
      const markdown = this._resolvedDocument()
      const options = this._saveOptions()

      this.writeState = 'writing'
      const attempt = (): Promise<void> =>
        window.electron.ipcRenderer.invoke('mt::review-write-file', pathname, markdown, options)
      writeChain = writeChain.then(attempt, attempt)

      try {
        await writeChain
        this.writeState = 'idle'
        this.writeError = null
      } catch (error) {
        this.writeState = 'error'
        this.writeError = error instanceof Error ? error.message : String(error)
      }
    },

    _maybeFinalize(): void {
      if (!this.active || this.remainingCount > 0 || this.writeState !== 'idle') {
        return
      }
      const { pathname, diskMeta } = this
      const markdown = this._resolvedDocument()
      const filename =
        diskMeta?.filename ?? pathname?.split(/[/\\]/).pop() ?? ''

      this.exitReview()
      // Reuses the external-reload path: refreshes muya via a single undo
      // boundary and marks the tab clean (editor now equals disk).
      useEditorStore().loadChange({
        pathname: pathname ?? '',
        data: {
          ...diskMeta,
          markdown,
          filename
        }
      })
    }
  }
})
