# AGENTS.md

Compact orientation for coding agents. `CLAUDE.md` (root) has the full architecture/directory writeup — read it for context. `packages/muya/CLAUDE.md` has muya-specific layout, conventions, and architecture notes. This file only adds what isn't already obvious from those.

## Repo shape

pnpm workspace, 3 real packages under `packages/*`: `desktop` (the Electron app, pnpm name `marktext`), `muyajs` (legacy JS editor engine, being retired), `muya` (TS rewrite, `@muyajs/core`, now the engine the desktop renderer actually consumes). `packages/website` is a standalone Vite/React site, not wired into CI.

Root `package.json` scripts are thin proxies: `pnpm lint` / `pnpm typecheck` / `pnpm test` / `pnpm build*` all forward to `packages/desktop` via `pnpm --filter marktext ...`. Always run these from the repo root, not inside `packages/desktop`.

## Commands that aren't obvious

- `pnpm check` = `pnpm lint && pnpm typecheck` — the combined pre-PR gate, not in CLAUDE.md's command list.
- Single desktop test: `pnpm -C packages/desktop exec vitest run <path>` (or `-t '<name>'`). Same pattern for muya: `pnpm -C packages/muya exec vitest run <path>`.
- `pnpm test:e2e` (desktop Playwright) requires a built app first — CI runs `pnpm build` immediately before `pnpm test:e2e`. On Linux it also needs `xvfb-run`.
- `packages/muya` is a fully separate toolchain: its own ESLint (antfu-based), stylelint, madge circular-dep check, and vitest configs. Root `pnpm lint`/`pnpm typecheck` do **not** cover it — use `pnpm -C packages/muya lint` / `lint:types` / `check-circular` instead.
- Muya's CommonMark/GFM conformance suite (`pnpm -C packages/muya test:spec`) is a ratchet: `test/spec/expected-failures.json` is the pass/fail baseline — an unlisted example that starts failing breaks CI, and a listed one that starts passing must be removed from the file. Compliance can only go up, never regress.
- No husky/pre-commit hooks exist in this repo — lint/typecheck/tests are not enforced locally on commit, only in CI. Run `pnpm check` yourself before finishing a task.
- CI splits desktop vs. muya work by path filters (`.github/workflows/lint.yml`/`test.yml`/`build.yml`/`e2e.yml` all skip `packages/muya/**`-only changes; `muya-*.yml` workflows only trigger on muya paths). If you touch both, expect both sets of workflows to run.

## Gotchas

- `pnpm install` runs `scripts/postinstall.ts`, which downloads Electron, applies `patch-package` patches (in `packages/desktop/patches/`), runs `electron-rebuild`, and minifies locales. If native/Electron-version behavior seems off after a fresh clone, re-run `pnpm install` rather than debugging the symptom directly.
- `renderer/` code compiles to ESM only — never add a `require()` there. `main/` and `preload/` are CommonJS.
- The renderer is sandboxed (`contextIsolation: true`, `nodeIntegration: false`) *except* the editor and preferences windows, which run with `contextIsolation: false` + `nodeIntegration: true` (see `packages/desktop/src/main/config.js`) — don't assume every window has the same Node access.
- Editing `main/` source requires restarting `pnpm run dev`; only the renderer hot-reloads (`Ctrl+R` reloads renderer + re-runs preload, not main).
- `pnpm run minify-locales` is required before production builds but intentionally skipped in `dev` — don't add it to dev workflows.
- PRs target the `develop` branch, not `main`.
