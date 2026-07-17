import { defineStore } from 'pinia'
import { computeHunks, type DiffHunk } from 'common/diff'
import type { HunkDecision } from 'common/diff/resolve'
import type { IFileState, LineEnding } from '@shared/types/files'

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
    }
  }
})
