import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parse, compileScript } from 'vue/compiler-sfc'
import ts from 'typescript'
import { computed } from 'vue'
import { describeHunk, summarizeHunk } from 'common/diff/summarize'

// reviewHunkCard.vue's bulk-action visibility (US-010) lives entirely in its
// <script setup> computeds (showBulkActions/pendingRuns/correlated/
// formattingCount) — there is no store mutation to assert on, only "given
// this store shape, does the card decide to show Keep all/Undo all". The
// desktop unit runner ships no @vitejs/plugin-vue / @vue/test-utils, so
// compile the real SFC at runtime, swap its imports for injected stubs, and
// run setup() to read the live computeds. Mirrors the approach in
// source-code-image-action.spec.ts / search-prefill.spec.ts.

const here = dirname(fileURLToPath(import.meta.url))
const vuePath = resolve(here, '../../../src/renderer/src/components/editorWithTabs/reviewHunkCard.vue')

interface Bindings {
  pendingRuns: { value: number }
  correlated: { value: boolean }
  showBulkActions: { value: boolean }
  formattingCount: { value: number }
}

const loadComponent = (deps: Record<string, unknown>) => {
  const src = readFileSync(vuePath, 'utf8')
  const { descriptor } = parse(src)
  const compiled = compileScript(descriptor, { id: 'test' })
  const noImports = compiled.content
    .split('\n')
    .filter((l) => !/^\s*import\s/.test(l))
    .join('\n')
  const js = ts.transpileModule(noImports, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    '__deps',
    'exports',
    'module',
    `const { _defineComponent, computed, describeHunk, summarizeHunk, useReviewStore, t } = __deps
    ${js}
    return module.exports`
  ) as (deps: Record<string, unknown>, exports: object, module: object) => {
    default: { setup: (props: unknown, ctx: { expose: () => void }) => Bindings }
  }
  const m = { exports: {} as Record<string, unknown> }
  return factory(deps, m.exports, m).default
}

interface StoreOpts {
  pending: number
  decidableLength: number
  syntaxOnly: number
}

// A minimal stand-in for useReviewStore exposing only what the card reads:
// hunks/editingHunkId/spotlightHunkId (unused by these computeds, but read
// by hunk/editing/spotted), decidableRuns (correlation), and the two count
// getters the bulk-action decision is built from.
const makeStore = (opts: StoreOpts) => ({
  hunks: [],
  editingHunkId: null,
  spotlightHunkId: null,
  decidableRuns: new Map<string, number[]>(
    opts.decidableLength > 0
      ? [['h1', Array.from({ length: opts.decidableLength }, (_, i) => i)]]
      : []
  ),
  pendingRunCount: () => opts.pending,
  syntaxOnlyRunCount: () => opts.syntaxOnly,
  viewFor: () => 'stacked',
  decide: async() => {},
  setSpotlight: () => {},
  beginEdit: () => {},
  toggleView: () => {}
})

const boot = (opts: StoreOpts): Bindings => {
  const deps = {
    _defineComponent: (o: unknown) => o,
    computed,
    describeHunk,
    summarizeHunk,
    useReviewStore: () => makeStore(opts),
    t: (key: string) => key
  }
  const comp = loadComponent(deps)
  return comp.setup(
    { hunkId: 'h1', ordinal: undefined, canToggleView: false },
    { expose: () => {} }
  )
}

describe('reviewHunkCard bulk-action threshold (US-010)', () => {
  it('shows Keep all/Undo all when the hunk correlates and >= 2 runs are pending', () => {
    const ret = boot({ pending: 2, decidableLength: 2, syntaxOnly: 0 })
    expect(ret.pendingRuns.value).toBe(2)
    expect(ret.correlated.value).toBe(true)
    expect(ret.showBulkActions.value).toBe(true)
  })

  it('falls back to plain Keep/Undo once only one run is pending, even though the hunk correlates', () => {
    const ret = boot({ pending: 1, decidableLength: 2, syntaxOnly: 0 })
    expect(ret.pendingRuns.value).toBe(1)
    expect(ret.correlated.value).toBe(true)
    expect(ret.showBulkActions.value).toBe(false)
  })

  it('falls back to plain Keep/Undo for an uncorrelated hunk, regardless of pending count', () => {
    const ret = boot({ pending: 3, decidableLength: 0, syntaxOnly: 0 })
    expect(ret.correlated.value).toBe(false)
    expect(ret.showBulkActions.value).toBe(false)
  })

  it('exposes the syntax-only run count for the "+ N formatting changes" disclosure', () => {
    const ret = boot({ pending: 2, decidableLength: 2, syntaxOnly: 3 })
    expect(ret.formattingCount.value).toBe(3)
  })

  it('reports zero formatting changes when the hunk seeded none', () => {
    const ret = boot({ pending: 2, decidableLength: 2, syntaxOnly: 0 })
    expect(ret.formattingCount.value).toBe(0)
  })
})
