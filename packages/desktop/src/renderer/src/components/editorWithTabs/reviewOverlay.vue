<template>
  <div
    ref="overlayRef"
    class="review-overlay"
    :class="wide ? 'wide' : 'narrow'"
    tabindex="0"
    @keydown="onKeydown"
  >
    <div
      class="review-document"
      :class="{ 'two-column': wide }"
    >
      <template
        v-for="row in renderedRows"
        :key="row.key"
      >
        <div class="doc-cell">
          <div
            v-if="row.segment.kind === 'unchanged'"
            class="review-segment"
            v-html="row.segment.html"
          />
          <div
            v-else
            class="review-region"
            :class="{ active: isActiveRegion(row.segment) }"
            :data-hunk-ids="row.segment.hunkIds.join(' ')"
          >
            <template
              v-for="(node, nodeIndex) in row.nodes"
              :key="nodeIndex"
            >
              <review-hunk-editor
                v-if="node.kind === 'editor'"
                :hunk-id="node.hunkId"
              />
              <div
                v-else-if="node.kind === 'stack'"
                class="hunk-card"
                :data-hunk-id="node.hunkId"
              >
                <div class="side before">
                  <span class="cap">{{ t('review.capBefore') }}</span>
                  <div
                    v-for="(beforePart, beforeIndex) in node.before"
                    :key="beforeIndex"
                    class="review-part review-deleted"
                    :data-hunk-id="node.hunkId"
                  >
                    <div
                      class="review-part-content"
                      v-html="beforePart.html"
                    />
                  </div>
                  <p
                    v-if="!node.before.length"
                    class="empty"
                  >
                    {{ t('review.emptyBefore') }}
                  </p>
                </div>
                <div class="side after">
                  <span class="cap">{{ t('review.capAfter') }}</span>
                  <div
                    v-for="(afterPart, afterIndex) in node.after"
                    :key="afterIndex"
                    class="review-part review-added"
                    :data-hunk-id="node.hunkId"
                  >
                    <div
                      class="review-part-content"
                      v-html="afterPart.html"
                    />
                  </div>
                  <p
                    v-if="!node.after.length"
                    class="empty"
                  >
                    {{ t('review.emptyAfter') }}
                  </p>
                </div>
              </div>
              <div
                v-else
                class="review-part"
                :class="`review-${node.part.role}`"
                :data-hunk-id="node.part.hunkId"
              >
                <review-hunk-controls
                  v-if="!wide && node.part.hunkId && node.firstOfHunk"
                  :hunk-id="node.part.hunkId"
                />
                <div
                  class="review-part-content"
                  v-html="node.part.html"
                />
              </div>
            </template>
          </div>
        </div>
        <div
          v-if="wide"
          class="card-cell"
        >
          <review-hunk-card
            v-for="(cardHunkId, cardIndex) in row.cardHunkIds"
            :key="cardHunkId"
            :hunk-id="cardHunkId"
            :ordinal="row.cardHunkIds.length > 1 ? cardIndex + 1 : undefined"
          />
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { renderToStaticHTML } from '@muyajs/core'
import { annotateMerged, computeRegions } from 'common/diff/regions'
import { useReviewStore } from '@/store/review'
import { applyWordMarks } from '@/util/reviewWordMarks'
import { applyInlineMerge, isSingleParagraph } from '@/util/reviewInlineMerge'
import { shouldGoWide } from '@/util/reviewLayout'
import { t } from '../../i18n'
import ReviewHunkControls from './reviewHunkControls.vue'
import ReviewHunkCard from './reviewHunkCard.vue'
import ReviewHunkEditor from './reviewHunkEditor.vue'

interface RenderedPart {
  role: 'context' | 'deleted' | 'added' | 'merged'
  hunkId?: string
  html: string
}

type RenderedSegment =
  | { kind: 'unchanged'; html: string }
  | { kind: 'region'; hunkIds: string[]; parts: RenderedPart[] }

/**
 * What actually renders in a document cell. A stacked hunk's parts are grouped
 * into one Before/After card; everything else stays a flat part.
 */
type RenderNode =
  | { kind: 'part'; part: RenderedPart; firstOfHunk: boolean }
  | { kind: 'editor'; hunkId: string }
  | { kind: 'stack'; hunkId: string; before: RenderedPart[]; after: RenderedPart[] }

/**
 * One row of the review layout: a document cell and the cards that belong
 * beside it. In the two-column layout both are emitted as flat grid siblings,
 * so a row is a pairing rather than a container.
 */
interface RenderRow {
  key: string
  segment: RenderedSegment
  nodes: RenderNode[]
  /** Hunks needing a margin card here, in document order; empty for context. */
  cardHunkIds: string[]
}

const reviewStore = useReviewStore()
const overlayRef = ref<HTMLElement | null>(null)

/**
 * Margin cards need a card column plus a readable measure beside it. Measured
 * on the overlay's own content box rather than the window, because the sidebar
 * and TOC panel take width the window size does not reflect.
 */
const wide = ref(false)

// Static fragments per markdown chunk; decided-hunk melt-back and unchanged
// segments re-render from this cache instead of re-parsing.
const htmlCache = new Map<string, string>()
const renderFragment = (markdown: string): string => {
  const cached = htmlCache.get(markdown)
  if (cached !== undefined) {
    return cached
  }
  const html: string = markdown.trim() === '' ? '' : (renderToStaticHTML(markdown) ?? '')
  htmlCache.set(markdown, html)
  return html
}

// A hunk inside a fenced code block arrives as bare code lines; re-wrapping
// them in their original fence renders them as a real (highlighted) block.
const fenceWrapped = (part: { markdown: string; fence?: string }): string => {
  if (!part.fence) {
    return part.markdown
  }
  const delimiter = part.fence.match(/`{3,}|~{3,}/)?.[0] ?? '```'
  return `${part.fence}\n${part.markdown}\n${delimiter}`
}

const renderedSegments = computed<RenderedSegment[]>(() => {
  const segments = computeRegions(
    annotateMerged(reviewStore.baselineText, reviewStore.hunks, reviewStore.decisions)
  )

  return segments.map((segment): RenderedSegment => {
    if (segment.kind === 'unchanged') {
      return { kind: 'unchanged', html: renderFragment(segment.markdown) }
    }

    const parts: RenderedPart[] = segment.parts
      // Fence delimiter lines are re-created around each fence-body part
      // below; rendering the bare delimiters would add empty code blocks.
      .filter((part) => !(part.fenceDelimiter && part.role === 'context'))
      .map((part) => ({
        role: part.role,
        hunkId: part.hunkId,
        html: renderFragment(fenceWrapped(part))
      }))
      .filter((part) => part.html !== '')

    for (const hunkId of segment.hunkIds) {
      const deleted = parts.find((p) => p.hunkId === hunkId && p.role === 'deleted')
      const added = parts.find((p) => p.hunkId === hunkId && p.role === 'added')
      if (!deleted || !added) {
        continue
      }
      try {
        const deletedEl = document.createElement('div')
        const addedEl = document.createElement('div')
        deletedEl.innerHTML = deleted.html
        addedEl.innerHTML = added.html

        // The merged view can only be drawn when both sides are one flowing
        // paragraph; lists, code and multi-block fragments always stack.
        const wantInline =
          reviewStore.viewFor(hunkId) === 'inline' &&
          isSingleParagraph(deletedEl) &&
          isSingleParagraph(addedEl)

        if (wantInline) {
          applyInlineMerge(deletedEl.textContent ?? '', addedEl)
          added.html = addedEl.innerHTML
          added.role = 'merged'
          parts.splice(parts.indexOf(deleted), 1)
        } else {
          applyWordMarks(deletedEl, addedEl)
          deleted.html = deletedEl.innerHTML
          added.html = addedEl.innerHTML
        }
      } catch {
        // Word marks and the merged view are progressive enhancement; on
        // failure the untouched pair still renders with its block tint.
      }
    }

    return { kind: 'region', hunkIds: segment.hunkIds, parts }
  })
})

/**
 * Projects segments into layout rows. Kept as a separate pass so the merge and
 * word-mark logic above stays untouched.
 *
 * Row keys lead with the hunk ids rather than the index alone: deciding a hunk
 * melts it into context and shifts every later index, which would repatch the
 * whole document and lose scroll position. Keying on content holds a region's
 * identity steady across a melt. The index still tiebreaks repeated context.
 */
/**
 * Groups a stacked hunk's parts into one Before/After card.
 *
 * "Stacked" is read off what the pass above actually produced — a hunk is
 * stacked iff it has no merged part — rather than from viewFor, because that
 * pass falls back to stacking whenever a fragment is not a single paragraph
 * even though the preference says inline.
 *
 * Grouping is wide-only: in narrow mode the floating controls anchor to
 * .review-part, so the document keeps exactly today's flat presentation.
 */
const buildNodes = (parts: RenderedPart[], grouped: boolean): RenderNode[] => {
  const firstIndexOfHunk = new Map<string, number>()
  const hasMergedPart = new Set<string>()
  parts.forEach((part, index) => {
    if (!part.hunkId) {
      return
    }
    if (!firstIndexOfHunk.has(part.hunkId)) {
      firstIndexOfHunk.set(part.hunkId, index)
    }
    if (part.role === 'merged') {
      hasMergedPart.add(part.hunkId)
    }
  })

  const nodes: RenderNode[] = []
  let index = 0
  while (index < parts.length) {
    const part = parts[index]
    const hunkId = part.hunkId
    const isFirst = hunkId !== undefined && firstIndexOfHunk.get(hunkId) === index

    if (hunkId !== undefined && reviewStore.editingHunkId === hunkId) {
      // The editor replaces every part of the hunk it is editing.
      if (isFirst) {
        nodes.push({ kind: 'editor', hunkId })
      }
      index++
      continue
    }

    if (grouped && hunkId !== undefined && isFirst && !hasMergedPart.has(hunkId)) {
      let end = index
      while (end < parts.length && parts[end].hunkId === hunkId) {
        end++
      }
      const run = parts.slice(index, end)
      // A fence delimiter can interleave a foreign part into the run; the
      // grouping is presentation only, so fall back to flat parts rather than
      // risk reordering content.
      if (run.every((candidate) => candidate.role === 'deleted' || candidate.role === 'added')) {
        nodes.push({
          kind: 'stack',
          hunkId,
          before: run.filter((candidate) => candidate.role === 'deleted'),
          after: run.filter((candidate) => candidate.role === 'added')
        })
        index = end
        continue
      }
    }

    nodes.push({ kind: 'part', part, firstOfHunk: isFirst })
    index++
  }
  return nodes
}

const renderedRows = computed<RenderRow[]>(() =>
  renderedSegments.value.map((segment, index) => {
    const hunkIds = segment.kind === 'region' ? segment.hunkIds : []
    return {
      key: `${segment.kind}:${hunkIds.join(',')}:${index}`,
      segment,
      nodes: segment.kind === 'region' ? buildNodes(segment.parts, wide.value) : [],
      cardHunkIds: hunkIds
    }
  })
)

const isActiveRegion = (segment: { hunkIds: string[] }): boolean =>
  reviewStore.activeHunkId !== null && segment.hunkIds.includes(reviewStore.activeHunkId)

let resizeObserver: ResizeObserver | null = null
let resizeFrame = 0

onMounted(() => {
  // Takes keyboard focus away from the (neutralized) contenteditable editor.
  overlayRef.value?.focus()

  if (!overlayRef.value || typeof ResizeObserver === 'undefined') {
    return
  }
  resizeObserver = new ResizeObserver((entries) => {
    const entry = entries[0]
    const width = entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width
    // Flipping the mode changes layout, which can re-fire the observer in the
    // same frame ("loop completed with undelivered notifications"); defer and
    // bail when the answer has not changed.
    cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => {
      const next = shouldGoWide(width, wide.value)
      if (next !== wide.value) {
        wide.value = next
      }
    })
  })
  resizeObserver.observe(overlayRef.value)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(resizeFrame)
  resizeObserver?.disconnect()
  resizeObserver = null
})

// Keeps the focused hunk in view as focusNext/focusPrev (keyboard or the
// review bar) move it — a hunk can have several parts, each carrying the
// same data-hunk-id, so the first match is enough to scroll to.
watch(
  () => reviewStore.activeHunkId,
  (hunkId) => {
    if (!hunkId) {
      return
    }
    nextTick(() => {
      overlayRef.value
        ?.querySelector(`[data-hunk-id="${hunkId}"]`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }
)

// The hunk editor's textarea holds keyboard focus while it's open; once it
// unmounts (confirm or cancel) the browser drops focus to <body>, which
// would silently swallow every subsequent shortcut (including Escape).
// Reclaim it the same way onMounted does initially.
watch(
  () => reviewStore.editingHunkId,
  (hunkId, previousHunkId) => {
    if (hunkId === null && previousHunkId !== null) {
      nextTick(() => {
        overlayRef.value?.focus()
      })
    }
  }
)

// While editing a hunk, the sub-editor owns Escape/Ctrl+Enter itself
// (stopped there); plain letter shortcuts are left alone so they still type
// normally into its textarea instead of triggering navigation/decisions.
const onKeydown = (event: KeyboardEvent): void => {
  if (reviewStore.editingHunkId) {
    return
  }

  const { key, altKey } = event
  if (key === 'j' || (altKey && key === 'ArrowDown')) {
    event.preventDefault()
    reviewStore.focusNext()
  } else if (key === 'k' || (altKey && key === 'ArrowUp')) {
    event.preventDefault()
    reviewStore.focusPrev()
  } else if ((key === 'a' || key === 'A') && reviewStore.activeHunkId) {
    event.preventDefault()
    reviewStore.decide(reviewStore.activeHunkId, { kind: 'accept' }).catch(console.error)
  } else if ((key === 'r' || key === 'R') && reviewStore.activeHunkId) {
    event.preventDefault()
    reviewStore.decide(reviewStore.activeHunkId, { kind: 'reject' }).catch(console.error)
  } else if ((key === 'e' || key === 'E') && reviewStore.activeHunkId) {
    event.preventDefault()
    reviewStore.beginEdit(reviewStore.activeHunkId)
  } else if (key === 'Escape') {
    event.preventDefault()
    reviewStore.requestExit()
  }
}
</script>

<style scoped>
.review-overlay {
  /* Sits below reviewBar.vue in a flex column (.review-container in
     editorWithTabs/index.vue), not absolutely positioned itself. */
  position: relative;
  flex: 1;
  overflow-y: auto;
  outline: none;
  background: var(--editorBgColor);
  color: var(--editorColor);
}

.review-document {
  max-width: var(--editorAreaWidth, 750px);
  margin: 0 auto;
  padding: 40px 20px 100px 20px;
  font-family: inherit;
  line-height: 1.6;
}

/* Document and margin cards are flat grid siblings, paired into a row by
   explicit grid-column. That pairing is the whole vertical-alignment
   mechanism — a card's top meets its paragraph with no JS positioning. */
.review-document.two-column {
  display: grid;
  grid-template-columns:
    minmax(0, var(--editorAreaWidth, 750px))
    var(--reviewCardCol, 280px);
  column-gap: var(--reviewCardGap, 28px);
  row-gap: 0;
  max-width: calc(
    var(--editorAreaWidth, 750px) + var(--reviewCardCol, 280px) + var(--reviewCardGap, 28px)
  );
}

.review-document.two-column > .doc-cell,
.review-document.two-column > .card-cell {
  /* Grid items default to min-width:auto, so a wide <pre> or <table> would
     blow its track out and push the card column off-screen. */
  min-width: 0;
}

.review-document.two-column > .doc-cell {
  grid-column: 1;
}

.review-document.two-column > .card-cell {
  grid-column: 2;
}

/* Rendered markdown fragments bring their own <p> margins (user-agent
   default ~1em top/bottom); left alone, that stacks with .review-part's
   own margin and inflates the gap around every diff block. Reset them and
   let .review-segment/.review-part control spacing explicitly instead. */
.review-document :deep(p) {
  margin: 0;
}

/* Segments and regions are each wrapped in a .doc-cell, so they are no longer
   siblings — spacing lives on the cell. Top-only: once this becomes a grid the
   cells are grid items, whose margins do not collapse. */
.doc-cell:not(:first-child) {
  margin-top: 8px;
}

.review-part {
  position: relative;
  border-radius: 3px;
  padding: 2px 8px;
  margin: 1px 0;
}

/* Narrow only: in the two-column layout every action lives in the margin card
   and the document column holds no buttons at all. */
.review-overlay.narrow .review-region:hover :deep(.review-hunk-controls),
.review-overlay.narrow .review-region.active :deep(.review-hunk-controls) {
  opacity: 1;
  pointer-events: auto;
}

/* Before/After comparison card for a stacked hunk. Holds no buttons — every
   action for this hunk lives on its margin card. */
.hunk-card {
  border: 1px solid var(--reviewCardBorder, var(--editorColor30, rgba(128, 128, 128, 0.3)));
  border-radius: 10px;
  overflow: hidden;
  margin: 2px 0;
}

.hunk-card .side {
  padding: 8px 12px 10px;
}

.hunk-card .side.before {
  background: var(--diffDeletedBg, rgba(220, 80, 80, 0.14));
}

.hunk-card .side.after {
  background: var(--diffAddedBg, rgba(70, 180, 100, 0.14));
}

.hunk-card .cap {
  display: block;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  margin-bottom: 3px;
}

.hunk-card .side.before .cap {
  color: var(--diffDeletedInk, rgba(173, 107, 115, 1));
}

.hunk-card .side.after .cap {
  color: var(--diffAddedInk, rgba(91, 147, 103, 1));
}

.hunk-card .empty {
  color: var(--editorColor60, rgba(128, 128, 128, 0.75));
  font-style: italic;
  font-size: 14px;
}

/* The side's own tint and caption carry the meaning inside a comparison card,
   so the part sheds its block treatment; word-level marks still apply. */
.hunk-card .review-part {
  background: transparent;
  padding: 0;
  margin: 0;
  text-decoration: none;
}

.review-deleted {
  background: var(--diffDeletedBg, rgba(220, 80, 80, 0.14));
  text-decoration: line-through;
  text-decoration-color: var(--diffDeletedStroke, rgba(220, 80, 80, 0.55));
}

.review-added {
  background: var(--diffAddedBg, rgba(70, 180, 100, 0.14));
}

/* The merged view carries no block tint: it holds both sides at once, so the
   word-level marks below are what distinguish them. */
.review-merged {
  background: var(--diffMergedBg, transparent);
}

.review-region.active {
  outline: 2px solid var(--diffActiveOutline, var(--themeColor));
  outline-offset: 2px;
  border-radius: 3px;
}

.review-document :deep(.review-word-del) {
  background: var(--diffDeletedWordBg, rgba(220, 80, 80, 0.35));
  border-radius: 2px;
}

.review-document :deep(.review-word-add) {
  background: var(--diffAddedWordBg, rgba(70, 180, 100, 0.35));
  border-radius: 2px;
}

/* Only the merged view emits a <del> element — stacked deletions are spans
   inside an already struck-through block, so this cannot double up on them. */
.review-document :deep(del.review-word-del) {
  text-decoration: line-through;
  text-decoration-color: var(--diffDeletedStroke, rgba(220, 80, 80, 0.55));
  text-decoration-thickness: 1.5px;
  padding: 0 2px;
}

/* Keep rendered fragments legible with editor-like typography. */
.review-document :deep(pre) {
  background: var(--codeBlockBgColor, rgba(128, 128, 128, 0.1));
  padding: 0.5em 1em;
  border-radius: 4px;
  overflow-x: auto;
}

.review-document :deep(table) {
  border-collapse: collapse;
}

.review-document :deep(th),
.review-document :deep(td) {
  border: 1px solid var(--editorColor30, rgba(128, 128, 128, 0.3));
  padding: 4px 10px;
}

.review-document :deep(blockquote) {
  border-left: 4px solid var(--themeColor);
  padding-left: 1em;
  margin-left: 0;
  opacity: 0.85;
}

.review-document :deep(img) {
  max-width: 100%;
}
</style>
