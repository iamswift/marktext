# PRD: Inline Diff Review (Track Changes for External Edits)

## Introduction

When an external tool (e.g. Claude Code, another editor, a sync service) modifies a markdown file that is open in MarkText, the user currently gets a blunt choice: reload the file (lose sight of what changed) or keep the in-editor version (ignore the change). Reviewing the change requires dropping into git or a diff tool, where complex markdown is hard to read and changes can only be taken wholesale or hunk-by-hunk in a raw-text UI.

This feature adds an **inline diff review mode** to MarkText's WYSIWYG editor. When an external change is detected on an open file, the editor renders the old and new versions merged into a single flowing rich document — additions and deletions shown in place, Track-Changes style — and lets the user **accept, reject, or edit each change individually** before the resolved content is written back to the file. The experience should feel like Word's Track Changes or Copilot's inline Keep/Undo, but for on-disk file changes in a rich markdown editor.

## Goals

- Detect external modifications to an open file and offer to review them inline instead of a reload-or-keep dialog.
- Render additions and deletions in place within the WYSIWYG document, styled distinctly (green/added, red-strikethrough/deleted), preserving rich rendering of the surrounding document.
- Allow each hunk to be individually accepted, rejected, or edited.
- Provide whole-document controls: change count, next/previous change navigation, Accept All, Reject All.
- Write each decision back to the file on disk immediately, so the file is always in a consistent, resolved state.
- Keep the flow entirely local and git-free — no repository required.
- Work first-class on Windows (the primary target platform): CRLF/BOM round-tripping, Windows watcher semantics, and file-lock resilience are requirements, not afterthoughts.

## User Stories

### US-001: Detect external change and offer review
**Description:** As a user with a file open in MarkText, I want the editor to detect when that file is modified on disk by an external tool and offer to review the changes inline, so that I don't have to choose blindly between "reload" and "keep mine".

**Acceptance Criteria:**
- [ ] The existing file-watcher path that fires when an open file changes on disk is extended with a "Review changes" option alongside the current reload/keep behavior.
- [ ] Choosing "Review changes" puts the tab into review mode with the diff computed between the in-editor content (baseline) and the on-disk content (proposed).
- [ ] If the in-editor content and on-disk content are identical (e.g. touch with no content change), no review is offered and behavior is unchanged from today.
- [ ] A preference controls the default action on external change: `Ask` (dialog, default) / `Always review` (enter review mode directly) / `Always reload` (today's auto-reload behavior).
- [ ] Typecheck/lint passes.

### US-002: Compute hunk-level diff
**Description:** As a developer, I need a diff module that turns (baseline markdown, proposed markdown) into an ordered list of hunks with stable IDs, so the UI and write-back logic have a shared model of "a change".

**Acceptance Criteria:**
- [ ] A pure module in `packages/desktop/src/common/` (or renderer-local if it needs no main-process use) computes a line-based diff and groups contiguous changed lines into hunks: `{ id, type: 'add' | 'delete' | 'replace', baselineRange, proposedRange, baselineText, proposedText }`.
- [ ] Replace hunks additionally carry word-level (intra-line) diff spans for highlighting, computed per line pair.
- [ ] Uses an established diff library (e.g. `diff` / jsdiff) rather than a hand-rolled algorithm.
- [ ] Unit tests cover: pure insertion, pure deletion, replacement, adjacent hunks, changes at file start/end, CRLF vs LF content, mixed line endings within one file, a leading UTF-8 BOM, and a no-op diff returning zero hunks.
- [ ] Typecheck/lint passes.

### US-003: Render inline diff in the WYSIWYG document
**Description:** As a user in review mode, I want additions and deletions rendered in place within the rich document, so I can read the document as it will flow while seeing exactly what changed.

**Acceptance Criteria:**
- [ ] In review mode the editor renders the *merged* view: unchanged content renders normally; added content renders with an "addition" treatment (e.g. green-tinted background); deleted content renders with a "deletion" treatment (e.g. red-tinted background with strikethrough), in document order at the position it was removed from.
- [ ] Rich rendering is preserved for unchanged content (headings, tables, code blocks, math, images render as usual).
- [ ] Added/deleted content is at minimum legible and clearly delimited even where full rich rendering of a partial construct isn't feasible (e.g. half a table row changed); it must never corrupt the rendering of unchanged content around it.
- [ ] Styling works in both light and dark themes.
- [ ] The document is read-only in review mode except through the review controls (US-004/US-005) — free typing is disabled until review completes or is exited.
- [ ] Typecheck/lint passes.
- [ ] Verified visually in the running app (`pnpm run dev`) with a fixture file covering headings, lists, a table, and a code block.

### US-004: Accept or reject an individual hunk
**Description:** As a user, I want per-change Accept and Reject controls on each hunk, so I can keep good changes and discard bad ones independently.

**Acceptance Criteria:**
- [ ] Hovering (or focusing) a hunk reveals its controls: **Accept** and **Reject** (plus **Edit**, see US-005).
- [ ] Accept resolves the hunk to the proposed text; Reject resolves it to the baseline text. The hunk's diff styling disappears and the resolved content renders normally.
- [ ] Each decision immediately writes the current resolved document (all decided hunks resolved, all undecided hunks resolved to *proposed* text is **not** acceptable — undecided hunks must round-trip so the on-disk file equals: baseline + accepted hunks applied + undecided hunks applied as proposed; see FR-10 for the exact rule).
- [ ] Remaining-change count in the review bar (US-006) decrements with each decision.
- [ ] When the last hunk is decided, review mode exits automatically and the editor returns to normal editing with the resolved content.
- [ ] Typecheck/lint passes.
- [ ] Verified in the running app: accept one hunk, reject another, confirm the file on disk after each decision.

### US-005: Edit a change before accepting
**Description:** As a user, I want to modify a proposed change rather than just accept or reject it verbatim, so I can fix a wording problem in an otherwise-good suggestion.

**Acceptance Criteria:**
- [ ] Each hunk has an **Edit** action that opens the hunk's proposed text for modification (inline editing of the hunk region, or a small inline editor panel — implementation may choose, but it must stay in-document, not a modal over a raw file view).
- [ ] Confirming the edit resolves the hunk to the edited text (counts as a decision, same write-back as Accept).
- [ ] Cancelling the edit returns the hunk to its undecided state.
- [ ] Typecheck/lint passes.
- [ ] Verified in the running app: edit a proposed change, confirm the edited text lands on disk.

### US-006: Review bar with navigation and bulk actions
**Description:** As a user reviewing a large change set, I want a persistent review bar showing progress and offering navigation and bulk actions, so I can work through many changes efficiently.

**Acceptance Criteria:**
- [ ] While in review mode a bar is visible showing: number of remaining changes, **Previous / Next** change navigation (scrolls to and highlights the hunk), **Accept All**, **Reject All**, and **Exit review**.
- [ ] Accept All / Reject All resolve every remaining hunk in one action and write back once.
- [ ] Exit review with undecided hunks prompts: "Accept remaining / Reject remaining / Cancel" (no silent data pick).
- [ ] Keyboard shortcuts exist for next/previous change and accept/reject the focused hunk (documented in the shortcut list).
- [ ] Typecheck/lint passes.
- [ ] Verified in the running app with a fixture producing 5+ hunks.

### US-007: Concurrent-change safety during review
**Description:** As a user, I want review mode to behave sanely if the file changes on disk *again* while I'm mid-review, so decisions are never silently lost or misapplied.

**Acceptance Criteria:**
- [ ] Write-backs performed by review decisions do not re-trigger the external-change flow for this tab (self-write suppression).
- [ ] If a genuinely external write lands mid-review, the user is notified and offered: restart review against the new on-disk content (already-decided hunks are re-applied where they still apply cleanly), or abandon review.
- [ ] If the file is deleted on disk mid-review, the existing file-deleted handling applies and review mode exits with the in-editor content preserved as unsaved.
- [ ] Unit tests cover the resolution/write-back function for: decisions in order, decisions out of order, and overlapping-restart re-application.
- [ ] Typecheck/lint passes.

### US-008: First-class Windows behavior
**Description:** As a Windows user (the primary platform for this feature), I want detection, diffing, and write-back to behave correctly with Windows file semantics, so review mode works with real-world tools like Claude Code, VS Code, and OneDrive-synced folders on NTFS.

**Acceptance Criteria:**
- [ ] External writes are detected regardless of how the tool saves: in-place write, truncate-then-write, and write-temp-then-rename/replace (the atomic-save pattern VS Code and many CLIs use, which surfaces as `rename`/`unlink`+`add` events rather than `change` on Windows).
- [ ] Rapid successive watcher events for one logical save (common with `ReadDirectoryChangesW`) are debounced into a single review offer; the on-disk content is only read after the write has settled (no partial-file reads).
- [ ] Reads and write-backs retry with backoff on transient `EBUSY`/`EPERM` (antivirus scanners, search indexer, or the external tool still holding the file); a persistent lock surfaces a clear error and leaves review state intact rather than failing silently.
- [ ] CRLF line endings and a leading UTF-8 BOM are preserved exactly on write-back — accepting or rejecting hunks never rewrites the file's line-ending style or strips/adds a BOM.
- [ ] Self-write suppression (FR-12) matches paths case-insensitively and after normalization, so `C:\Docs\a.md` and `c:\docs\A.MD` are recognized as the same file; paths with spaces, non-ASCII characters, and OneDrive-managed folders work.
- [ ] The end-to-end flow (external write → review → accept/reject/edit → file verified on disk) is exercised on a Windows machine before the feature is considered done; unit tests for the Windows-sensitive logic (debounce, retry, EOL/BOM round-trip, path comparison) run on all platforms.
- [ ] Typecheck/lint passes.

## Functional Requirements

- FR-1: The system must detect on-disk modification of any open file (existing watcher) and, per the user's preference, show a dialog offering **Review changes**, **Reload**, and **Keep current** or take the configured default action.
- FR-2: Entering review mode must compute a diff with the **in-editor content as baseline** and the **on-disk content as proposed**, grouped into hunks per US-002.
- FR-3: If the tab has unsaved local edits when the external change arrives, the baseline is the unsaved in-editor content (the diff then shows exactly what accepting would do to the user's current text). This must be stated in the review bar (e.g. "comparing against your unsaved version").
- FR-4: In review mode the editor must render the merged document: unchanged content with normal WYSIWYG rendering, additions and deletions inline at their document position with visually distinct, theme-aware styling and word-level highlights inside replaced lines.
- FR-5: Each hunk must expose Accept, Reject, and Edit actions reachable by mouse (hover controls) and keyboard (focused hunk + shortcuts).
- FR-6: Accept must resolve a hunk to its proposed text; Reject to its baseline text; Edit to user-supplied text.
- FR-7: The review bar must show remaining-change count and provide Previous/Next navigation, Accept All, Reject All, and Exit review.
- FR-8: Review mode must disable direct document editing; the only mutations are through hunk decisions.
- FR-9: Each decision must trigger an immediate write of the file on disk.
- FR-10: The on-disk content after any write must equal: baseline with every **decided** hunk replaced by its resolution and every **undecided** hunk replaced by its **proposed** text. (Rationale: the external tool's write already put the proposed text on disk; undecided regions must not be reverted by a partial write. Rejecting is what actively removes a change from disk.)
- FR-11: When all hunks are decided (individually or via bulk action), review mode must exit and the tab must return to normal editing, marked clean (in-editor content equals on-disk content).
- FR-12: Writes originating from review decisions must not re-trigger the external-change detection for that tab.
- FR-13: A new preference (Preferences → General or File handling) must control the on-external-change behavior: Ask (default) / Always review / Always reload.
- FR-14: The diff must handle CRLF and LF content without spurious whole-file hunks, and preserve the file's existing line-ending style on write-back. Internally, diffing operates on normalized line content; EOL style and any leading UTF-8 BOM are captured once and re-applied on serialization.
- FR-15: External-change detection must recognize all common Windows save patterns — in-place `change`, truncate+write, and temp-file rename/replace (which arrives as delete/rename+create events) — and must debounce event bursts from a single logical save, reading the file only after the write has settled.
- FR-16: File reads and write-backs must tolerate transient Windows sharing violations (`EBUSY`/`EPERM`) with bounded retry/backoff; on persistent failure, the user gets an actionable error and review state (decisions made so far) is preserved in memory.
- FR-17: All path comparisons in the feature (self-write suppression, watcher-to-tab matching) must use normalized, case-insensitive comparison on Windows, and must handle drive-letter paths, spaces, non-ASCII characters, and long paths (`\\?\` / >260 chars where Electron supports them).

## Non-Goals (Out of Scope)

- **No git integration.** Diffing against HEAD or arbitrary revisions is explicitly out of scope for v1; the only baseline is the in-editor content vs. the on-disk file. (The hunk model should not preclude adding other diff sources later.)
- **No source-code-mode (CodeMirror) diff rendering.** Review mode is WYSIWYG-only; switching a tab in review mode to source mode either exits review (with the US-006 prompt) or is disabled.
- **No external proposal API.** External tools propose changes only by writing the file; no IPC/CLI channel for pushing change sets into a running window in v1.
- **No multi-file review.** Review mode is per-tab; there is no aggregated "3 files changed" review queue.
- **No change attribution, comments, or history.** No author metadata, threaded discussion, or persistent record of past reviews.
- **No deferred write-back mode.** Immediate-per-decision is the only write model in v1.

## Design Considerations

- Visual language follows the familiar conventions in the reference screenshots (Copilot inline review): red-tinted strikethrough for deletions, green-tinted for additions, a compact floating control cluster per hunk, and a slim persistent review bar. Must respect MarkText's theme system (light/dark + custom themes) — use theme CSS variables, not hardcoded colors.
- Hunk controls should be unobtrusive at rest (revealed on hover/focus) so a heavily-edited document remains readable.
- Deleted block-level content (e.g. a removed heading + paragraph) renders as a distinct "deleted block" region rather than trying to interleave strikethrough into surrounding live blocks.
- Reuse existing MarkText UI primitives (notification/dialog components, editor float boxes) where possible.

## Technical Considerations

- **Entry point (verified in code):** `packages/desktop/src/main/filesystem/watcher.ts` already watches open files with chokidar using `awaitWriteFinish` (1000ms stability / 150ms poll) and has self-write suppression (`ignoreChangedEvent` + an mtime-stat fallback for cloud drives, GH#3044) — FR-12 and the settle logic in FR-15 largely exist. The `change` handler loads the file in the main process and sends `mt::update-file` with the full parsed payload: `{ markdown, lineEnding, isMixedLineEndings, adjustLineEndingOnSave, trimTrailingNewline, encoding, filename }` — i.e. the **proposed content and its EOL/encoding metadata already arrive in the renderer**. The renderer branch point is `LISTEN_FOR_FILE_CHANGE` in `packages/desktop/src/renderer/src/store/editor.ts` (~line 1650): today it shows a tab notification whose confirm action calls `loadChange(...)` (full reload). "Review changes" is a third action at exactly this point; the identical-content no-op check (US-001) already exists there (#1861). Note: `pushTabNotification` currently supports only a single confirm action — the notification UI needs a small extension for three choices.
- **Windows rename caveat (verify empirically first):** the watcher has a Linux-specific atomic-rename fix (chokidar#591) but no Windows equivalent. A temp+rename save on Windows may surface as `unlink` (which today triggers the "file removed on disk" warning) followed by `add`. Before building US-001, test how a VS Code save and a Claude Code write actually surface through this watcher on Windows and handle the observed sequence — do not assume `change`.
- **The hard problem is merged rendering.** The renderer's editor engine is `@muyajs/core` (packages/muya). Two candidate approaches, to be decided by a rendering spike before US-003 is built out:
  1. **Decorated document:** load the merged text (baseline + proposed interleaved) into muya as real blocks tagged with hunk metadata, styled via classes. Pros: real rich rendering. Cons: merged text is not valid standalone markdown; muya has no native concept of ephemeral/annotation blocks.
  2. **Overlay view:** render a dedicated review component (Vue) that reuses muya's parser/renderer output for unchanged regions and injects diff-styled segments between them, replacing the editable surface while in review mode. Pros: doesn't fight the editing engine (review mode is read-only anyway per FR-8). Cons: parallel rendering path to keep consistent.
  Given FR-8 (review mode is read-only), approach 2 is likely lower-risk; US-005's inline edit only needs a small editable region per hunk, not full muya editing.
- **Diff library:** `diff` (jsdiff) is pure JS, MIT, widely used; suitable for renderer or common. Word-level spans via `diffWords`/`diffWordsWithSpace` per changed line pair.
- **Self-write suppression:** the save path already distinguishes editor-initiated writes (the watcher flow must not fire on MarkText's own saves today); review write-backs must go through the same path or reuse the same suppression mechanism.
- **State:** review state (hunks, decisions, active hunk) belongs in a Pinia store or per-tab state in the editor store, so the review bar, hunk controls, and write-back logic share one source of truth.
- **Performance:** diff computation is O(file size); fine for typical documents. The merged render must stay usable on a 5,000-line document with 100+ hunks (virtualize or lazy-render if needed — measure first).
- **Windows watcher semantics:** MarkText's watcher is chokidar-based, which uses `ReadDirectoryChangesW` on Windows. Atomic saves (temp+rename) can surface as `unlink`+`add` rather than `change` — the existing watcher already handles some of this for the reload flow; verify and extend rather than assume. Use chokidar's `awaitWriteFinish` (or equivalent settle logic) so the proposed content is never read mid-write.
- **Windows write-back:** prefer the same save path the editor already uses (it must already cope with Windows locks and preserve encodings). If review write-back needs its own path, atomic temp+rename on the same volume is the safe default, with retry on `EPERM` (rename over a file briefly held by AV/indexer is the classic Windows failure). Never write through a different casing of the path than the tab holds.
- **EOL/BOM model:** MarkText already tracks line-ending preference and encoding per document — reuse that metadata for FR-14 rather than re-detecting. The hunk model (US-002) stores normalized text; serialization re-applies the document's EOL and BOM.
- **Dev/verify environment is Windows:** the primary development machine for this feature runs Windows 11, so `pnpm run dev` manual verification in every UI story is inherently a Windows verification. Keep the Windows-sensitive logic (debounce, retry, EOL/BOM, path normalization) in pure, platform-parameterized modules so unit tests cover it on Linux CI too.

## Success Metrics

- A change set produced by an external tool can be reviewed and fully resolved (mix of accept/reject/edit) without leaving MarkText or touching git, in a document containing headings, lists, tables, and code blocks.
- After any sequence of decisions, the file on disk exactly matches the FR-10 rule — verified by automated tests on the resolution function.
- Reviewing a 20-hunk change takes only the decisions themselves — no per-hunk mode switching, scrolling hunts, or manual saves.
- No regressions in the existing reload/keep external-change flow when the feature is set to "Always reload" or the review option is declined.
- On Windows: a CRLF+BOM file edited externally by Claude Code and fully reviewed in MarkText is byte-identical in EOL style and BOM to what a pure accept-all would produce — no incidental reformatting; a save from VS Code (atomic rename) triggers exactly one review offer.

## Open Questions

- **Unsaved-edits baseline (FR-3):** comparing against unsaved in-editor content is the least surprising option, but if the external tool's edit was based on the *saved* file, the diff conflates the user's unsaved edits with the tool's changes. Is a three-way presentation (yours / theirs / base) ever needed, or is the two-way diff acceptable for v1?
- **Word-level accept granularity:** hunks are the decision unit in v1. Is finer granularity (accept individual word changes within a hunk) worth a v2, or does Edit cover that need?
- **Intra-inline changes:** when a change is a few words inside one paragraph, should the whole paragraph be one hunk (simpler) or should each contiguous inline change be independently decidable? V1 assumes line/hunk granularity per US-002.
- **Session persistence:** if MarkText is closed mid-review, undecided hunks are effectively accepted (they're on disk per FR-10). Is that acceptable, or should review state persist across restarts?
- **Auto-save interplay (found in code):** with auto-save enabled and the tab clean, `LISTEN_FOR_FILE_CHANGE` currently reloads external changes silently with no prompt. Does `Always review` / `Ask` take precedence over that silent reload (proposed: yes — the review preference wins over auto-save's reload shortcut), or does auto-save keep its current behavior unless the user opts into review?
