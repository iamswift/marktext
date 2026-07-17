# Manual testing: Inline Diff Review (Windows)

Companion to `tasks/prd-inline-diff-review.md`. This walks through testing the
feature by hand on a Windows machine, on top of the automated suites
(`pnpm run test:unit`, `pnpm run test:e2e`) which already cover the same
scenarios headlessly. Use this when you want to actually *see* the overlay,
try the keyboard shortcuts, or sanity-check something the automated specs
don't assert on (visual theme, feel, timing).

## 1. Environment setup (this machine's known gotchas)

- **pnpm**: if not on PATH, `npm i -g pnpm@10.33.4` (matches the repo's
  `packageManager` field). Corepack may be broken (stale signature keys) —
  the global install sidesteps that.
- **Native rebuild / VS Build Tools**: the repo's `.npmrc` pins
  `msvs_version=2022`. If only VS2019 BuildTools is installed:
  ```powershell
  $env:npm_config_msvs_version = '2019'
  $env:GYP_MSVS_VERSION = '2019'
  ```
  Set these before any `pnpm install` or rebuild.
- **native-keymap Spectre workaround**: VS2019 without the "Spectre-mitigated
  libs" component fails with MSB8040. Either install that VS component, or:
  1. Edit `node_modules/.pnpm/native-keymap@3.3.9/.../binding.gyp`, set
     `'SpectreMitigation': 'false'` (keep it BOM-free).
  2. From `packages/desktop`: `pnpm exec electron-rebuild -f -w native-keymap -o native-keymap`.
  3. A fresh `pnpm install` reverts this — reapply if native modules start failing.

## 2. Build and launch

```powershell
pnpm install
```

Then pick one of these to actually launch the app:

- **Iterating on code** (recommended day to day): `pnpm run dev` — hot
  reloads the renderer; `main/`/`preload/` changes need the dev server
  restarted (`Ctrl+C`, rerun), `Ctrl+R` in the app window only reloads the
  renderer + preload.
- **Testing a built bundle without packaging** (what e2e runs against):
  ```powershell
  pnpm run build:unpack
  node_modules\.bin\electron.cmd packages\desktop
  ```
  This launches Electron directly against `packages/desktop/out/` (main/
  preload/renderer bundles), the same way `test/e2e/helpers.ts` does — no
  installer, no `dist/` output.
- **A real installed/portable build** (heavier, only if you specifically
  need to test the packaged app): `pnpm run build:win:x64`, then run
  `dist\win-unpacked\marktext.exe` (or the NSIS installer next to it, also
  under `dist\`).

## 3. Turn on review mode

Preferences → General → **"When an open file is changed on disk"** → set to
**"Ask what to do"** (default) or **"Review changes inline"**. The "Ask"
setting is the more realistic day-to-day setting: it puts a "Review" button
next to "Reload" on the existing external-change notification. "Review
changes inline" skips straight to the overlay. Try both.

## 4. Triggering an external change

Open a `.md` file in MarkText, then edit it from *outside* the app. All of
these should be recognized as an external change and (per your preference)
offer Review:

- **PowerShell**, simplest:
  ```powershell
  Start-Sleep -Milliseconds 1500   # clear the watcher's 1s awaitWriteFinish window
  Set-Content -Path "C:\path\to\file.md" -Value "new content" -NoNewline
  ```
- **VS Code**: open the same file in VS Code, edit, `Ctrl+S`.
- **An actual external tool** (the real scenario this feature targets): have
  Claude Code, Copilot, or any agent edit the file while it's open in
  MarkText.
- **Temp+rename** (what a lot of editors do under the hood):
  ```powershell
  Set-Content -Path "C:\path\to\file.md.tmp" -Value "new content" -NoNewline
  Move-Item -Path "C:\path\to\file.md.tmp" -Destination "C:\path\to\file.md" -Force
  ```

If you want to watch the raw chokidar event sequence for any of these (useful
if something seems off), run the dev build with verbose watcher logging:

```powershell
$env:MARKTEXT_DEBUG_VERBOSE = '3'
pnpm run dev
```

## 5. Walk the review UI

Once you click "Review" (or it opens directly under `Always review`):

- **Overlay** — the WYSIWYG area is replaced by a read-only merged view:
  unchanged content renders normally, changed hunks show deleted (struck
  through, red-tinted) and added (green-tinted) parts inline, with
  word-level highlights within a changed line where the rendered text lets
  it track back to source (tables/code fences intentionally fall back to
  block-level tint only — that's by design, not a bug).
- **Per-hunk controls** — hover a changed region: Accept / Reject / Edit
  buttons appear on the hunk's first part.
  - **Accept**: keeps the external tool's version; disk is rewritten
    immediately.
  - **Reject**: discards the external change, restores your original text;
    disk is rewritten immediately.
  - **Edit**: swaps the hunk for a plain textarea pre-filled with the
    proposed text. `Ctrl+Enter` (or the "Save edit" button) confirms — your
    edited text is what lands on disk, not the external tool's original
    proposal. `Esc` (or "Cancel") discards the edit and leaves the hunk
    undecided.
- **Review bar** (top of the overlay) — remaining-hunk count, Prev/Next,
  Accept all / Reject all, Exit. If you started reviewing from unsaved
  edits, a banner says so.
- **Keyboard**, while the overlay has focus:
  - `j` / `k` or `Alt+↓` / `Alt+↑` — move the focused hunk.
  - `a` / `r` / `e` — accept / reject / edit the focused hunk.
  - `Esc` — if a hunk's editor is open, cancels it; otherwise asks how to
    leave the review (see below).
- **Every decision writes to disk immediately.** Check the file's mtime or
  reopen it in another editor as you go — you shouldn't need to wait for
  "finishing" the review to see partial progress on disk. The *last*
  decision auto-exits the review (the tab goes back to normal, clean).

## 6. Exiting mid-review

With hunks still undecided, try each of these — they should all route
through the same "Accept remaining / Reject remaining / Keep reviewing"
prompt rather than silently discarding review state:

- Click **Exit review** on the review bar.
- Press **Esc** on the overlay (with no hunk editor open).
- Toggle **View → Source Code Mode** (menu or `Ctrl+/` depending on your
  keybindings) while reviewing — it must *not* actually enter source mode.
- Try to **close the tab** (`Ctrl+W`) while reviewing.

"Keep reviewing" should dismiss the prompt and leave everything exactly as it
was.

## 7. Mid-review concurrency (a second external edit)

While a review is open with hunks still undecided, edit the file externally
*again* (same techniques as step 4). You should get a new notification:
**Restart review** / **Abandon review**.

- **Restart review**: re-diffs against the newest disk content. Any hunk you
  already decided, whose *exact* baseline/proposed text recurs unchanged in
  the new diff, stays decided — you shouldn't have to redo it. Anything new
  or altered comes back undecided.
- **Abandon review**: drops the review entirely and reloads the tab to the
  newest disk content.

Also try **deleting the file** externally mid-review (`Remove-Item`) — the
review should exit and the tab should show as unsaved (there's nothing left
on disk to write back to).

## 8. Windows-specific byte-fidelity check (CRLF / BOM)

This is the check most likely to surface a *real* Windows-only bug (line
ending or encoding round-tripping). Create a CRLF+BOM fixture and diff bytes
before/after a review:

```powershell
$path = "$env:TEMP\review-crlf-bom-test.md"
$content = "Title`r`n`r`nOriginal paragraph.`r`n"
[System.IO.File]::WriteAllText($path, $content, [System.Text.UTF8Encoding]::new($true)) # BOM

# Open $path in MarkText, wait >1s, then externally rewrite it:
Start-Sleep -Milliseconds 1500
$modified = "Title`r`n`r`nRewritten paragraph.`r`n"
[System.IO.File]::WriteAllText($path, $modified, [System.Text.UTF8Encoding]::new($true))

# After reviewing (accept/reject/edit however you like) and the review
# exits, compare bytes:
$bytes = [System.IO.File]::ReadAllBytes($path)
"{0:X2} {1:X2} {2:X2}" -f $bytes[0], $bytes[1], $bytes[2]   # expect EF BB BF (BOM)
[System.Text.Encoding]::UTF8.GetString($bytes) -match "`r`n"  # expect True (CRLF preserved)
```

Expected: the BOM and CRLF line endings are preserved through every write —
`writeMarkdownFile` re-applies them from the on-disk change's own metadata on
every review write-back, not from stale tab state.

## 9. Locked-file retry

Hold the file open exclusively in another process (e.g. open it in Notepad
and don't release the lock the way some tools do, or use a small script that
opens it with `FileShare.None`), then try to Accept/Reject a hunk. You should
see the write fail with an actionable error rather than silently losing your
decision — the decision itself should stay recorded so you can retry once
the lock clears.

## 10. Cross-check against the automated suites

Everything above has an automated equivalent that should already be green;
running them is a fast way to confirm nothing regressed relative to what's
described here:

```powershell
# Full unit suite
pnpm run test:unit

# Just the review-mode specs
pnpm -C packages/desktop exec vitest run test/unit/specs/diff-hunks.spec.ts test/unit/specs/diff-resolve.spec.ts test/unit/specs/diff-word.spec.ts test/unit/specs/diff-regions.spec.ts test/unit/specs/review-word-marks.spec.ts test/unit/specs/review-store-decisions.spec.ts test/unit/specs/review-store-nav.spec.ts test/unit/specs/review-restart.spec.ts test/unit/specs/review-exit-guards.spec.ts test/unit/specs/file-change-action.spec.ts test/unit/specs/fs-retry.spec.ts test/unit/specs/watcher-unlink-coalesce.spec.ts test/unit/specs/watcher-ignore-path-case.spec.ts

# Type check + lint
pnpm run typecheck
pnpm run lint

# E2E (requires a fresh build:unpack first — e2e runs against out/, not src/)
pnpm run build:unpack
pnpm -C packages/desktop exec playwright test test/e2e/review-mode.spec.ts

# Full e2e suite (slower, ~2-3 minutes)
pnpm run test:e2e
```

### Known pre-existing failures on this machine (unrelated to this feature)

None of these touch review/tabs/preferences code — they're environment- or
muya-engine-level issues that predate this branch:

- `test/unit/specs/move-image-to-folder.spec.ts` — fails 7/7 even on a clean
  `develop` checkout on this machine.
- `test/unit/specs/pdf.spec.ts` — flaky under full-suite parallelism, passes
  standalone.
- `test/e2e/all-blocks-roundtrip.spec.ts` — fails on this machine with every
  block separated by an extra blank line versus the fixture; this is a muya
  serialization difference unrelated to any file this feature touches.
- `test/e2e/search-prefill-from-selection.spec.ts` — a double-click
  word-selection test expects `"fox"` but gets `"fox "` (trailing space); a
  browser/OS word-boundary quirk, unrelated to this feature.

If you see failures beyond this list, they're worth investigating as real
regressions.
