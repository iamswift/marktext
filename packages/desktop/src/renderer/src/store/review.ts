import { defineStore } from 'pinia'
import { toRaw } from 'vue'
import { computeHunks, normalizeText, type DiffHunk } from 'common/diff'
import { classifyHunk, type ReviewViewKind } from 'common/diff/classify'
import { computeEditRuns } from 'common/diff/editRuns'
import { resolveDocument, type HunkDecision } from 'common/diff/resolve'
import { useEditorStore } from './editor'
import { usePreferencesStore } from './preferences'
import { t } from '../i18n'
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
  /**
   * Sub-hunk decisions, keyed by hunk id then by EditRun.index. Lets a
   * partially-reviewed hunk (some runs accepted, some rejected, some still
   * pending) write back correctly before the whole hunk has a decision of
   * its own — see resolveRuns in common/diff/resolve.ts. Session-scoped for
   * the same reason as viewOverrides: hunk ids are re-keyed on restart, so a
   * decision keyed to a stale hunk id would silently misapply to whatever
   * hunk now holds that id.
   */
  runDecisions: Map<string, Map<number, 'accept' | 'reject'>>
  /**
   * Which of a hunk's edit-run indexes the overlay was able to correlate to
   * a per-change decision (RunCorrelation.decidable from reviewInlineMerge).
   * The store cannot run that correlation itself — it needs rendered DOM —
   * so the overlay reports the result here via setDecidableRuns as it
   * renders. A hunk absent from this map, or mapped to [], was never
   * correlated: decide() and hunk decided-ness fall back to the pre-US-007
   * binary, hunk-level behavior for it. Session-scoped for the same reason
   * as runDecisions.
   */
  decidableRuns: Map<string, number[]>
  /**
   * Per-hunk hand overrides of the classified view. Session-scoped: hunk ids
   * are re-keyed whenever the review restarts, so a stale override would
   * otherwise land on an unrelated hunk.
   */
  viewOverrides: Map<string, ReviewViewKind>
  /**
   * The hunk the user clicked a margin card for. Kept separate from
   * activeHunkId: that one is the keyboard cursor and must always point at an
   * undecided hunk, while a spotlight is pointer-driven, freely cleared, and
   * must never scroll.
   */
  spotlightHunkId: string | null
  /** Consumed by the overlay's focus watcher; see setSpotlight. */
  suppressNextFocusScroll: boolean
  /**
   * The single change "Undo last change" would restore. Null after a bulk
   * decision, since there is no one change left to single out.
   */
  lastDecidedHunkId: string | null
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
  runDecisions: new Map(),
  decidableRuns: new Map(),
  viewOverrides: new Map(),
  spotlightHunkId: null,
  suppressNextFocusScroll: false,
  lastDecidedHunkId: null,
  activeHunkId: null,
  editingHunkId: null,
  diskMeta: null,
  writeState: 'idle',
  writeError: null
})

export const useReviewStore = defineStore('review', {
  state: initialState,

  getters: {
    /**
     * Hunks still open for review. A hunk counts as decided — and drops out
     * of this list, `remainingCount`, and finalize's trigger — once it has a
     * whole-hunk decision OR every one of its correlated decidable runs has
     * one; see `isHunkDecided`. The unit stays hunks, not runs: the review
     * bar must read as stable progress through paragraphs, not flicker with
     * every individual Keep/Undo click inside one.
     */
    undecidedHunks(): DiffHunk[] {
      return this.hunks.filter((hunk) => !this.isHunkDecided(hunk.id))
    },
    remainingCount(): number {
      return this.undecidedHunks.length
    },
    /**
     * A hunk is done when it has a whole-hunk decision, or — for a hunk the
     * overlay correlated via setDecidableRuns — every one of its decidable
     * run indexes has an entry in runDecisions. A hunk with no (or an empty)
     * decidableRuns entry can only be decided the first way: without this
     * guard, "every one of zero runs is decided" would vacuously mark an
     * uncorrelated hunk decided the instant it appeared.
     */
    isHunkDecided() {
      return (hunkId: string): boolean => {
        if (this.decisions.has(hunkId)) {
          return true
        }
        const decidable = this.decidableRuns.get(hunkId)
        if (!decidable || decidable.length === 0) {
          return false
        }
        const runs = this.runDecisions.get(hunkId)
        return decidable.every((index) => runs?.has(index))
      }
    },
    decidedCount(): number {
      return this.hunks.length - this.undecidedHunks.length
    },
    /**
     * How a hunk should render, in precedence order: a hand override, then a
     * non-auto layout preference, then the classifier. Presentation only — it
     * never affects how a decision resolves.
     */
    viewFor() {
      return (hunkId: string): ReviewViewKind => {
        const override = this.viewOverrides.get(hunkId)
        if (override) {
          return override
        }
        const layout = usePreferencesStore().reviewDiffLayout ?? 'auto'
        if (layout !== 'auto') {
          return layout
        }
        const hunk = this.hunks.find((candidate) => candidate.id === hunkId)
        return hunk ? classifyHunk(hunk) : 'stacked'
      }
    },
    /** How many of a hunk's edit runs have neither been accepted nor rejected. */
    pendingRunCount() {
      return (hunkId: string): number => {
        const hunk = this.hunks.find((candidate) => candidate.id === hunkId)
        if (!hunk) {
          return 0
        }
        const decided = this.runDecisions.get(hunkId)
        return computeEditRuns(hunk).filter((run) => !decided?.has(run.index)).length
      }
    }
  },

  actions: {
    /**
     * Starts a review of the on-disk change against the tab's current content.
     * Returns false when there is no line-level difference (e.g. an EOL-only
     * change) — the caller should fall back to a plain reload in that case.
     *
     * `wasUnsaved` defaults to the tab's current isSaved flag, but callers
     * that defer entering review behind a notification action (the 'ask'
     * pathway forces tab.isSaved false the moment the change arrives, before
     * the user even picks "Review") must capture and pass the tab's dirty
     * state from *before* that mutation — otherwise FR-3's banner would
     * fire on every review, unsaved edits or not.
     */
    enterReview(
      tab: IFileState,
      change: ReviewChangePayload,
      wasUnsaved: boolean = !tab.isSaved
    ): boolean {
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
        baselineWasUnsaved: wasUnsaved,
        hunks,
        decisions: new Map(),
        runDecisions: new Map(),
        decidableRuns: new Map(),
        viewOverrides: new Map(),
        spotlightHunkId: null,
        suppressNextFocusScroll: false,
        lastDecidedHunkId: null,
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
     * Highlights one hunk and its margin card. Also points the keyboard cursor
     * at it so a/r/e act on what was clicked — but raises
     * suppressNextFocusScroll, because the card is already beside its
     * paragraph and scrolling it to centre would yank the page away from the
     * pointer. Decided hunks are left alone: activeHunkId must stay on
     * something still decidable.
     */
    setSpotlight(hunkId: string | null): void {
      this.spotlightHunkId = hunkId
      if (hunkId && !this.decisions.has(hunkId) && this.activeHunkId !== hunkId) {
        this.suppressNextFocusScroll = true
        this.activeHunkId = hunkId
      }
    },

    /**
     * Puts a decided hunk back up for review and rewrites the file without it
     * applied. The hunk simply reappears as a region on the next render, so
     * this needs no change to the diff region model.
     *
     * Only reachable mid-review: the last decision finalizes and exits, which
     * is why this is "undo the last change" rather than a per-card control on
     * a settled card.
     */
    async undecide(hunkId: string): Promise<void> {
      if (!this.active || !this.decisions.has(hunkId)) {
        return
      }
      this.decisions.delete(hunkId)
      if (this.lastDecidedHunkId === hunkId) {
        this.lastDecidedHunkId = null
      }
      // Put the cursor on what just came back so a/r/e act on it.
      this.activeHunkId = hunkId
      this.suppressNextFocusScroll = false
      await this._writeResolved()
    },

    /** Flips one hunk between the merged and before/after renderings. */
    toggleView(hunkId: string): void {
      const current = this.viewFor(hunkId)
      this.viewOverrides.set(hunkId, current === 'inline' ? 'stacked' : 'inline')
    },

    /**
     * Records a decision and writes the resolved document. The decision is
     * kept even when the write fails (FR-16) — retryWrite re-attempts the
     * same resolution. Finalizes the review after the last decision lands.
     *
     * For an accept/reject on a hunk the overlay has correlated, this fills
     * every still-undecided run rather than recording a whole-hunk decision
     * — see `_applyHunkDecision`. That is what makes "Keep all" produce the
     * same bytes as deciding every run by hand: a run already settled by
     * decideRun (accept or reject) must survive a later bulk decide
     * untouched, and a whole-hunk decision recorded here would instead win
     * outright over those per-run decisions (see `_effectiveDecisions`).
     */
    async decide(hunkId: string, decision: HunkDecision): Promise<void> {
      if (!this.active || this.isHunkDecided(hunkId)) {
        return
      }
      const hunk = this.hunks.find((h) => h.id === hunkId)
      if (!hunk) {
        return
      }

      this._applyHunkDecision(hunkId, decision)
      this._settleHunk(hunkId)

      await this._writeResolved()
      this._maybeFinalize()
    },

    /**
     * Records one edit run's decision within a hunk that has no whole-hunk
     * decision yet. Once this fills the last of the hunk's correlated
     * decidable runs, the hunk is fully decided — same settle + finalize
     * treatment as a whole-hunk decide().
     */
    async decideRun(hunkId: string, runIndex: number, kind: 'accept' | 'reject'): Promise<void> {
      if (!this.active || this.isHunkDecided(hunkId)) {
        return
      }
      if (!this.hunks.some((h) => h.id === hunkId)) {
        return
      }
      let runs = this.runDecisions.get(hunkId)
      if (!runs) {
        runs = new Map()
        this.runDecisions.set(hunkId, runs)
      }
      runs.set(runIndex, kind)

      await this._writeResolved()

      if (this.isHunkDecided(hunkId)) {
        this._settleHunk(hunkId)
        this._maybeFinalize()
      }
    },

    /** Puts one run back up for review, leaving its sibling runs' decisions intact. */
    async revertRun(hunkId: string, runIndex: number): Promise<void> {
      if (!this.active) {
        return
      }
      const runs = this.runDecisions.get(hunkId)
      if (!runs || !runs.has(runIndex)) {
        return
      }
      runs.delete(runIndex)
      if (runs.size === 0) {
        this.runDecisions.delete(hunkId)
      }
      await this._writeResolved()
    },

    /**
     * Registers which of a hunk's edit runs the overlay correlated to a
     * per-change decision this render (RunCorrelation.decidable). Safe to
     * call every render: a hunk the overlay never correlates simply never
     * gets an entry, and decide()/isHunkDecided treat that exactly like
     * before US-007 — one binary, hunk-level decision.
     */
    setDecidableRuns(hunkId: string, runIndexes: number[]): void {
      this.decidableRuns.set(hunkId, runIndexes)
    },

    /**
     * Seeds a hunk's syntax-only runs (RunCorrelation.syntaxOnly — markdown
     * formatting changes with no decision UI of their own) as accepted, so
     * `pendingRunCount` converges to zero once every decidable run is
     * resolved instead of sitting stuck on a change nobody is ever asked to
     * decide. Only fills indexes that carry no decision yet: the overlay may
     * re-correlate on every render, and a run the user separately decided
     * through decideRun must never be clobbered back to 'accept'. Never
     * changes the resolved document (an unfilled run already resolves to
     * proposed, same as 'accept'), so it never writes.
     */
    seedSyntaxOnlyRuns(hunkId: string, runIndexes: number[]): void {
      let runs = this.runDecisions.get(hunkId)
      for (const index of runIndexes) {
        if (runs?.has(index)) {
          continue
        }
        if (!runs) {
          runs = new Map()
          this.runDecisions.set(hunkId, runs)
        }
        runs.set(index, 'accept')
      }
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

    /** Moves the focused hunk forward/backward through the undecided list, wrapping. */
    focusNext(): void {
      this._focusBy(1)
    },

    focusPrev(): void {
      this._focusBy(-1)
    },

    _focusBy(direction: 1 | -1): void {
      const { undecidedHunks, activeHunkId } = this
      if (undecidedHunks.length === 0) {
        this.activeHunkId = null
        return
      }
      const currentIndex = undecidedHunks.findIndex((hunk) => hunk.id === activeHunkId)
      const nextIndex =
        currentIndex === -1
          ? direction > 0
            ? 0
            : undecidedHunks.length - 1
          : (currentIndex + direction + undecidedHunks.length) % undecidedHunks.length
      this.activeHunkId = undecidedHunks[nextIndex].id
    },

    /**
     * Asks how to leave a review with hunks still undecided (source-mode
     * toggle, tab close, the review bar's Exit button, or Esc on the
     * overlay). Reuses the tab-notification contract from M3 — Cancel just
     * dismisses the prompt and leaves the review active.
     */
    requestExit(): void {
      if (!this.active) {
        return
      }
      if (this.remainingCount === 0) {
        // Nothing left to decide; _maybeFinalize would have already exited,
        // but guard against being called from a stale UI state.
        this.exitReview()
        return
      }

      const { tabId } = this
      if (!tabId) {
        return
      }
      useEditorStore().pushTabNotification({
        tabId,
        msg: t('review.exitPromptMessage', { count: this.remainingCount }),
        exclusiveType: 'review_exit',
        buttons: [
          { label: t('review.acceptRemaining'), value: 'accept' },
          { label: t('review.rejectRemaining'), value: 'reject' },
          { label: t('review.cancelExit'), value: 'cancel' }
        ],
        action: (status) => {
          if (status === 'accept') {
            this.acceptAll().catch(() => {})
          } else if (status === 'reject') {
            this.rejectAll().catch(() => {})
          }
          // 'cancel', dismiss (false), or the default OK path: stay in review.
        }
      })
    },

    /**
     * A second external write landed on disk while this tab was already
     * under review. Asks whether to re-diff against the new content
     * (carrying forward decisions whose hunk content recurs unchanged) or to
     * abandon the in-progress review entirely and just reload.
     */
    handleExternalChangeDuringReview(change: ReviewChangePayload): void {
      if (!this.active) {
        return
      }
      const { tabId } = this
      if (!tabId) {
        return
      }
      useEditorStore().pushTabNotification({
        tabId,
        msg: t('review.midReviewChangeMessage'),
        exclusiveType: 'review_mid_change',
        buttons: [
          { label: t('review.restartReview'), value: 'restart' },
          { label: t('review.abandonReview'), value: 'abandon' }
        ],
        action: (status) => {
          if (status === 'restart') {
            this.restartAgainstNewDisk(change).catch(() => {})
          } else if (status === 'abandon') {
            this.exitReview()
            useEditorStore().loadChange(this._asLoadChangePayload(change))
          }
          // Dismiss/default: keep reviewing against the now-stale proposed
          // text — the next write-back will still be FR-10-correct against
          // it, just not reflecting this second external edit yet.
        }
      })
    },

    /**
     * Re-diffs the frozen baseline against the newest on-disk content.
     * Decisions are carried forward by contentKey (same baseline/proposed
     * line pair), so a hunk the user already resolved stays resolved even
     * though its hunk id changed; anything new or altered comes back
     * undecided.
     */
    async restartAgainstNewDisk(change: ReviewChangePayload): Promise<void> {
      if (!this.active) {
        return
      }

      const newHunks = computeHunks(this.baselineText, change.data.markdown)
      if (newHunks.length === 0) {
        // The new disk content now matches the frozen baseline exactly —
        // nothing left to review.
        const payload = this._asLoadChangePayload(change)
        this.exitReview()
        useEditorStore().loadChange(payload)
        return
      }

      const decisionsByContentKey = new Map<string, HunkDecision>()
      for (const hunk of this.hunks) {
        const decision = this.decisions.get(hunk.id)
        if (decision) {
          decisionsByContentKey.set(hunk.contentKey, decision)
        }
      }

      const carried = new Map<string, HunkDecision>()
      for (const hunk of newHunks) {
        const decision = decisionsByContentKey.get(hunk.contentKey)
        if (decision) {
          carried.set(hunk.id, decision)
        }
      }

      this.$patch({
        proposedText: change.data.markdown,
        hunks: newHunks,
        decisions: carried,
        // Unlike whole-hunk decisions, run decisions are NOT carried forward
        // by contentKey — a stale run index surviving a restart could land on
        // an unrelated edit in the re-diffed hunk, so the safer default is to
        // make every run undecided again. decidableRuns resets alongside it:
        // the overlay re-correlates and re-registers on the next render.
        runDecisions: new Map(),
        decidableRuns: new Map(),
        // Decisions are carried across by contentKey, but views and the
        // spotlight are not: the ids they were keyed to no longer refer to the
        // same hunks.
        viewOverrides: new Map(),
        spotlightHunkId: null,
        suppressNextFocusScroll: false,
        lastDecidedHunkId: null,
        activeHunkId: newHunks.find((hunk) => !carried.has(hunk.id))?.id ?? null,
        editingHunkId: null,
        diskMeta: change.data,
        writeState: 'idle',
        writeError: null
      })

      // Carried-over decisions may differ from what's currently on disk
      // (e.g. a rejected hunk whose content the external tool wrote again),
      // so reconcile immediately.
      await this._writeResolved()
      this._maybeFinalize()
    },

    /** The file was deleted mid-review: there is nothing left to write back to. */
    handleFileDeleted(): void {
      if (!this.active) {
        return
      }
      const { tabId } = this
      this.exitReview()
      if (tabId) {
        const editorStore = useEditorStore()
        const tab = editorStore.tabs.find((t) => t.id === tabId)
        if (tab) {
          tab.isSaved = false
        }
      }
    },

    async _decideRemaining(decision: HunkDecision): Promise<void> {
      if (!this.active || this.remainingCount === 0) {
        return
      }
      // Same per-hunk rule as decide(): a hunk with runs already decided by
      // hand keeps them, rather than a bulk accept/reject overwriting them
      // outright via a whole-hunk decision.
      for (const hunk of this.undecidedHunks) {
        this._applyHunkDecision(hunk.id, decision)
      }
      this.editingHunkId = null
      this.activeHunkId = null
      this.spotlightHunkId = null
      // A bulk decision leaves no single change to single out.
      this.lastDecidedHunkId = null
      await this._writeResolved()
      this._maybeFinalize()
    },

    // `loadChange` (editor.ts) requires a filename; ReviewChangeData's is
    // optional (it mirrors the on-disk change payload, which doesn't always
    // carry one), so fall back to the pathname's basename like
    // `_maybeFinalize` does.
    _asLoadChangePayload(change: ReviewChangePayload): Parameters<
      ReturnType<typeof useEditorStore>['loadChange']
    >[0] {
      return {
        pathname: change.pathname,
        data: {
          ...change.data,
          filename: change.data.filename ?? change.pathname.split(/[/\\]/).pop() ?? ''
        }
      }
    },

    /**
     * Fills every still-undecided decidable run of a hunk with `kind`,
     * leaving any run that already has its own accept/reject untouched.
     * Returns false without touching anything for a hunk the overlay never
     * correlated (no decidableRuns entry), so callers fall back to a plain
     * whole-hunk decision — the pre-US-007 behavior.
     */
    _fillRemainingRuns(hunkId: string, kind: 'accept' | 'reject'): boolean {
      const decidable = this.decidableRuns.get(hunkId)
      if (!decidable || decidable.length === 0) {
        return false
      }
      let runs = this.runDecisions.get(hunkId)
      if (!runs) {
        runs = new Map()
        this.runDecisions.set(hunkId, runs)
      }
      for (const index of decidable) {
        if (!runs.has(index)) {
          runs.set(index, kind)
        }
      }
      return true
    },

    /**
     * Applies a whole-hunk accept/reject/edit to one hunk, without the
     * active/write/finalize bookkeeping decide() and _decideRemaining() each
     * own at their own call sites (the latter batches many hunks under one
     * write). An edit decision always replaces the hunk outright — bulk fill
     * only makes sense for accept/reject, which map onto per-run
     * accept/reject directly.
     */
    _applyHunkDecision(hunkId: string, decision: HunkDecision): void {
      if (
        (decision.kind === 'accept' || decision.kind === 'reject') &&
        this._fillRemainingRuns(hunkId, decision.kind)
      ) {
        return
      }
      this.decisions.set(hunkId, decision)
    },

    /**
     * Bookkeeping shared by decide() and decideRun() for whichever one just
     * brought a hunk to fully decided: point the cursor elsewhere, record it
     * as the one "undo last change" would restore, and drop any UI state
     * that assumed the hunk was still open.
     */
    _settleHunk(hunkId: string): void {
      if (this.editingHunkId === hunkId) {
        this.editingHunkId = null
      }
      if (this.spotlightHunkId === hunkId) {
        // The hunk melts into context on the next render — nothing left to lit.
        this.spotlightHunkId = null
      }
      this.lastDecidedHunkId = hunkId
      if (this.activeHunkId === hunkId) {
        this.activeHunkId = this.undecidedHunks[0]?.id ?? null
      }
    },

    /**
     * The one place runDecisions folds into the shape resolveDocument
     * expects, so write-back and finalize never have to duplicate this
     * merge. A hunk with its own decision wins outright: decide() only ever
     * records one when the hunk has no correlated decidable runs (see
     * _applyHunkDecision), so this can never discard a real per-run decision
     * in favor of a stale whole-hunk one.
     */
    _effectiveDecisions(): Map<string, HunkDecision> {
      const merged = new Map(this.decisions)
      for (const [hunkId, runs] of this.runDecisions) {
        if (!merged.has(hunkId) && runs.size > 0) {
          merged.set(hunkId, { kind: 'runs', runs: new Map(runs) })
        }
      }
      return merged
    },

    _resolvedDocument(): string {
      return resolveDocument(this.baselineText, this.hunks, this._effectiveDecisions())
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
