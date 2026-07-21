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
      @click="onEditAction"
      @mouseover="onEditHover"
      @focusin="onEditFocus"
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
                :class="{ spot: isSpotlit(node.hunkId) }"
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
                :class="[`review-${node.part.role}`, { spot: isSpotlit(node.part.hunkId) }]"
                :data-hunk-id="node.part.hunkId"
              >
                <review-hunk-controls
                  v-if="!wide && node.part.hunkId && node.firstOfHunk"
                  :hunk-id="node.part.hunkId!"
                  :can-toggle-view="renderedSegments.inlineCapable.has(node.part.hunkId!)"
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
            :can-toggle-view="canToggleView(cardHunkId)"
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
import {
  applyInlineMerge,
  correlateRuns,
  isSingleParagraph,
  wrapDecidableRuns
} from '@/util/reviewInlineMerge'
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

/**
 * Segments plus which hunks are capable of the merged ('inline') rendering.
 * Capability is independent of the current view preference — a hunk sitting
 * in 'stacked' must stay distinguishable from one that can never merge, so
 * the card knows whether to offer the toggle at all.
 */
interface RenderedSegments {
  segments: RenderedSegment[]
  inlineCapable: Set<string>
}

const renderedSegments = computed<RenderedSegments>(() => {
  const segments = computeRegions(
    annotateMerged(reviewStore.baselineText, reviewStore.hunks, reviewStore.effectiveDecisions())
  )
  const inlineCapable = new Set<string>()
  // Read once per pass rather than inside the loop: t() call cost is trivial,
  // but this keeps every run's popover on this render sharing one object.
  const runActionLabels = {
    keep: t('review.keepChange'),
    undo: t('review.undoChange'),
    edit: t('review.editParagraph'),
    kept: t('review.changeKept'),
    undone: t('review.changeUndone')
  }

  const renderedSegmentList = segments.map((segment): RenderedSegment => {
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
        const mergeable = isSingleParagraph(deletedEl) && isSingleParagraph(addedEl)
        if (mergeable) {
          inlineCapable.add(hunkId)
        }
        const wantInline = reviewStore.viewFor(hunkId) === 'inline' && mergeable

        if (wantInline) {
          const hunk = reviewStore.hunks.find((candidate) => candidate.id === hunkId)
          const deletedText = deletedEl.textContent ?? ''
          const addedText = addedEl.textContent ?? ''
          // Must run before applyInlineMerge, which splices <del> nodes into
          // addedEl and so changes its textContent — correlateRuns' own
          // reading of "the proposed text" would otherwise be wrong.
          const correlation = hunk ? correlateRuns(hunk, deletedEl, addedEl) : null

          applyInlineMerge(deletedText, addedEl)

          const wrappedRunIndexes = correlation
            ? wrapDecidableRuns(
              hunkId,
              deletedText,
              addedText,
              addedEl,
              correlation.decidable,
              runActionLabels,
              reviewStore.runDecisions.get(hunkId)
            )
            : []

          added.html = addedEl.innerHTML
          added.role = 'merged'
          parts.splice(parts.indexOf(deleted), 1)

          // Only the runs that actually got a `.review-edit` wrapper are
          // reported decidable — a run wrapDecidableRuns had to skip has no
          // UI to decide it individually, so it must fall back to the whole
          // hunk's Keep/Undo rather than sit permanently pending.
          reviewStore.setDecidableRuns(hunkId, wrappedRunIndexes)
          if (correlation) {
            reviewStore.seedSyntaxOnlyRuns(
              hunkId,
              correlation.syntaxOnly.map((run) => run.index)
            )
          }
        } else {
          applyWordMarks(deletedEl, addedEl)
          deleted.html = deletedEl.innerHTML
          added.html = addedEl.innerHTML
          // Clears a correlation from a previous render — e.g. the user
          // toggled this hunk to stacked view — so isHunkDecided and
          // _fillRemainingRuns fall back to whole-hunk behavior instead of
          // waiting on runs that no longer have any UI to decide them.
          reviewStore.setDecidableRuns(hunkId, [])
        }
      } catch {
        // Word marks and the merged view are progressive enhancement; on
        // failure the untouched pair still renders with its block tint.
      }
    }

    return { kind: 'region', hunkIds: segment.hunkIds, parts }
  })

  return { segments: renderedSegmentList, inlineCapable }
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
      const stackable = run.every(
        (candidate) => candidate.role === 'deleted' || candidate.role === 'added'
      )
      // A pure add or delete has no pair to compare, so its inline view is the
      // single tinted block; the Before/After card, with its empty half, is
      // opt-in via the toggle. A two-sided replace with no merged part always
      // stacks — it either chose 'stacked' or could not merge, same rendering.
      const oneSided = stackable && run.every((candidate) => candidate.role === run[0].role)
      if (stackable && !(oneSided && reviewStore.viewFor(hunkId) === 'inline')) {
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
  renderedSegments.value.segments.map((segment, index) => {
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

// The spotlight tints; activeHunkId outlines. Separate channels, so the
// pointer highlight and the keyboard cursor can show at once without reading
// as the same thing.
const isSpotlit = (hunkId?: string): boolean =>
  hunkId !== undefined && reviewStore.spotlightHunkId === hunkId

// A one-sided hunk always has both renderings available: the single tinted
// block, or a Before/After card with one empty half.
const canToggleView = (hunkId: string): boolean => {
  const hunk = reviewStore.hunks.find((candidate) => candidate.id === hunkId)
  return hunk !== undefined && hunk.type !== 'replace'
    ? true
    : renderedSegments.value.inlineCapable.has(hunkId)
}

// Finds the `.review-edit` wrapper an event originated from. That markup is
// injected via v-html (see wrapDecidableRuns), so it carries no Vue
// listeners of its own — every interaction with it is handled here, on the
// real DOM event that bubbled up from inside the rendered fragment.
const editWrapperFrom = (event: Event): HTMLElement | null =>
  (event.target as HTMLElement | null)?.closest<HTMLElement>('.review-edit') ?? null

/**
 * Sizes and sides a run's popover against its actual on-screen position —
 * CSS alone shows/hides it (:hover/:focus-within), but placement needs the
 * wrapper's real geometry, which only exists once the fragment is mounted.
 * Flips below the wrapper when there is no room above the scroll
 * container's own visible top (a first-line change would otherwise render
 * its popover clipped above the viewport), and clamps horizontal centering
 * so a change near either edge of the column keeps its popover on screen.
 */
const positionEditPopover = (wrapper: HTMLElement): void => {
  const popover = wrapper.querySelector<HTMLElement>('.review-edit-popover')
  const host = overlayRef.value
  if (!popover || !host) {
    return
  }
  const wrapperRect = wrapper.getBoundingClientRect()
  const hostRect = host.getBoundingClientRect()
  const popRect = popover.getBoundingClientRect()

  const fitsAbove = wrapperRect.top - popRect.height - 8 >= hostRect.top
  popover.classList.toggle('below', !fitsAbove)

  const halfWidth = popRect.width / 2
  const center = wrapperRect.left + wrapperRect.width / 2
  const minCenter = hostRect.left + halfWidth + 4
  const maxCenter = hostRect.right - halfWidth - 4
  const clampedCenter = Math.min(Math.max(center, minCenter), maxCenter)
  popover.style.setProperty('--pop-shift', `${clampedCenter - center}px`)
}

const onEditHover = (event: MouseEvent): void => {
  const wrapper = editWrapperFrom(event)
  if (wrapper) {
    positionEditPopover(wrapper)
  }
}

const onEditFocus = (event: FocusEvent): void => {
  const wrapper = editWrapperFrom(event)
  if (wrapper) {
    positionEditPopover(wrapper)
  }
}

// Delegated handler for a popover's Keep/Undo/Edit buttons — plain <button>
// elements inside the v-html fragment, identified by the data attributes
// wrapDecidableRuns/buildPopover stamped on them.
const onEditAction = (event: MouseEvent): void => {
  const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('.review-edit-action')
  if (button) {
    const { hunkId, reviewAct } = button.dataset
    const runIndex = Number(button.dataset.runIndex)
    if (!hunkId || Number.isNaN(runIndex)) {
      return
    }
    if (reviewAct === 'keep') {
      reviewStore.decideRun(hunkId, runIndex, 'accept').catch(console.error)
    } else if (reviewAct === 'undo') {
      reviewStore.decideRun(hunkId, runIndex, 'reject').catch(console.error)
    } else if (reviewAct === 'edit') {
      reviewStore.beginEdit(hunkId)
    }
    return
  }

  // A settled run (US-009) has no popover — the whole wrapper is the
  // affordance, and clicking it puts the run back up for review.
  const settled = editWrapperFrom(event)
  if (settled?.classList.contains('review-edit-settled') && settled.dataset.hunkId) {
    const runIndex = Number(settled.dataset.runIndex)
    if (!Number.isNaN(runIndex)) {
      reviewStore.revertRun(settled.dataset.hunkId, runIndex).catch(console.error)
    }
  }
}

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
    if (reviewStore.suppressNextFocusScroll) {
      // A card click moved the cursor here; the paragraph is already on screen
      // beside that card, so scrolling would displace what the user clicked.
      reviewStore.suppressNextFocusScroll = false
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

  const { key, altKey, target } = event
  // Enter/Space on a settled run (US-009) has no popover to open — the
  // wrapper is the whole affordance, so activating it reverts the run
  // directly, the keyboard equivalent of the click handled in onEditAction.
  if (
    (key === 'Enter' || key === ' ') &&
    target instanceof HTMLElement &&
    target.classList.contains('review-edit-settled')
  ) {
    event.preventDefault()
    const { hunkId } = target.dataset
    const runIndex = Number(target.dataset.runIndex)
    if (hunkId && !Number.isNaN(runIndex)) {
      reviewStore.revertRun(hunkId, runIndex).catch(console.error)
    }
    return
  }
  // Enter on the wrapper itself (not a popover button, which handles its own
  // activation) reveals the popover and moves focus into it — the wrapper's
  // :focus-within already shows it, but a keyboard user tabbing to the
  // wrapper has no other way to learn Keep/Undo/Edit exist there.
  if (key === 'Enter' && target instanceof HTMLElement && target.classList.contains('review-edit')) {
    event.preventDefault()
    positionEditPopover(target)
    target.querySelector<HTMLButtonElement>('.review-edit-action')?.focus()
    return
  }
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
    // Escape dismisses the spotlight first — otherwise there is no keyboard
    // way out of it — and exits the review on a second press.
    if (reviewStore.spotlightHunkId) {
      reviewStore.setSpotlight(null)
    } else {
      reviewStore.requestExit()
    }
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

/* Spotlight tints; .active outlines. Two channels so the pointer highlight and
   the keyboard cursor never read as the same state. */
.review-part.spot {
  background: var(--diffSpotBg, rgba(127, 166, 207, 0.16));
}

.hunk-card.spot {
  border-color: var(--diffSpotBorder, rgba(127, 166, 207, 0.8));
  box-shadow: 0 2px 10px rgba(51, 97, 143, 0.16);
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

/* US-008: one decidable run inside a merged paragraph. Focusable so Tab
   reaches it; :hover/:focus-within alone reveal the popover — placement
   (side/horizontal clamp) is the only part JS has to do, since it needs the
   wrapper's real on-screen position (see positionEditPopover). */
.review-document :deep(.review-edit) {
  position: relative;
  border-radius: 3px;
  cursor: pointer;
}

.review-document :deep(.review-edit:hover del.review-word-del),
.review-document :deep(.review-edit:hover .review-word-add),
.review-document :deep(.review-edit:focus-within del.review-word-del),
.review-document :deep(.review-edit:focus-within .review-word-add) {
  filter: saturate(1.35) brightness(0.97);
}

.review-document :deep(.review-edit-popover) {
  display: none;
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(calc(-50% + var(--pop-shift, 0px)));
  gap: 2px;
  padding: 3px;
  border-radius: 8px;
  border: 1px solid var(--reviewCardBorder, var(--editorColor30, rgba(128, 128, 128, 0.3)));
  background: var(--floatBgColor, var(--editorBgColor));
  box-shadow: var(--reviewCardShadow, 0 1px 3px rgba(0, 0, 0, 0.1));
  white-space: nowrap;
  z-index: 6;
}

/* Set by positionEditPopover when there is no room above the scroll
   container's own visible top (a first-line change). */
.review-document :deep(.review-edit-popover.below) {
  bottom: auto;
  top: calc(100% + 6px);
}

.review-document :deep(.review-edit:hover .review-edit-popover),
.review-document :deep(.review-edit:focus-within .review-edit-popover) {
  display: inline-flex;
}

.review-document :deep(.review-edit-action) {
  appearance: none;
  border: none;
  background: transparent;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  padding: 3px 9px;
  line-height: 1.4;
  color: var(--editorColor);
}

.review-document :deep(.review-edit-action.keep:hover) {
  background: var(--diffAddedBg, rgba(70, 180, 100, 0.14));
}

.review-document :deep(.review-edit-action.undo:hover) {
  background: var(--diffDeletedBg, rgba(220, 80, 80, 0.14));
}

.review-document :deep(.review-edit-action.edit) {
  color: var(--editorColor60, rgba(128, 128, 128, 0.75));
}

.review-document :deep(.review-edit-action.edit:hover) {
  background: var(--editorColor10, rgba(128, 128, 128, 0.12));
}

/* US-009: a settled run carries no tint, strikethrough, or border — it reads
   as ordinary prose (color/weight inherited) until the reviewer hovers or
   tabs to it, at which point a subtle underline is the only signal that it
   is still reversible. Its accessible name (aria-label, set in
   reviewInlineMerge) and the native `title` tooltip are what state the
   actual decision. */
.review-document :deep(.review-edit-settled) {
  border-radius: 2px;
}

.review-document :deep(.review-edit-settled:hover),
.review-document :deep(.review-edit-settled:focus-visible) {
  text-decoration: underline;
  text-decoration-style: dotted;
  text-decoration-color: var(--editorColor60, rgba(128, 128, 128, 0.6));
  text-underline-offset: 2px;
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
