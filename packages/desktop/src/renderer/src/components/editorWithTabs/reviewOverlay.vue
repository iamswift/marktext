<template>
  <div
    ref="overlayRef"
    class="review-overlay"
    tabindex="0"
    @keydown="onKeydown"
  >
    <div class="review-document">
      <template v-for="(segment, index) in renderedSegments">
        <div
          v-if="segment.kind === 'unchanged'"
          :key="`u-${index}`"
          class="review-segment"
          v-html="segment.html"
        />
        <div
          v-else
          :key="`r-${index}`"
          class="review-region"
          :class="{ active: isActiveRegion(segment) }"
          :data-hunk-ids="segment.hunkIds.join(' ')"
        >
          <template
            v-for="(part, partIndex) in segment.parts"
            :key="partIndex"
          >
            <review-hunk-editor
              v-if="part.hunkId && isEditingHunkPart(segment, part, partIndex)"
              :hunk-id="part.hunkId"
            />
            <div
              v-else-if="!isEditingHunkOtherPart(part)"
              class="review-part"
              :class="`review-${part.role}`"
              :data-hunk-id="part.hunkId"
            >
              <review-hunk-controls
                v-if="part.hunkId && isFirstPartOfHunk(segment, partIndex)"
                :hunk-id="part.hunkId"
              />
              <div
                class="review-part-content"
                v-html="part.html"
              />
            </div>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { renderToStaticHTML } from '@muyajs/core'
import { annotateMerged, computeRegions } from 'common/diff/regions'
import { useReviewStore } from '@/store/review'
import { applyWordMarks } from '@/util/reviewWordMarks'
import { applyInlineMerge, isSingleParagraph } from '@/util/reviewInlineMerge'
import ReviewHunkControls from './reviewHunkControls.vue'
import ReviewHunkEditor from './reviewHunkEditor.vue'

interface RenderedPart {
  role: 'context' | 'deleted' | 'added' | 'merged'
  hunkId?: string
  html: string
}

type RenderedSegment =
  | { kind: 'unchanged'; html: string }
  | { kind: 'region'; hunkIds: string[]; parts: RenderedPart[] }

const reviewStore = useReviewStore()
const overlayRef = ref<HTMLElement | null>(null)

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

const isActiveRegion = (segment: { hunkIds: string[] }): boolean =>
  reviewStore.activeHunkId !== null && segment.hunkIds.includes(reviewStore.activeHunkId)

const isFirstPartOfHunk = (
  segment: { parts: RenderedPart[] },
  partIndex: number
): boolean => {
  const { hunkId } = segment.parts[partIndex]
  if (!hunkId) {
    return false
  }
  return segment.parts.findIndex((p) => p.hunkId === hunkId) === partIndex
}

// While a hunk is being edited, its normal deleted/added parts are replaced
// by a single reviewHunkEditor — rendered once, on the hunk's first part;
// every other part belonging to that hunk renders nothing.
const isEditingHunkPart = (
  segment: { parts: RenderedPart[] },
  part: RenderedPart,
  partIndex: number
): boolean =>
  part.hunkId !== undefined &&
  reviewStore.editingHunkId === part.hunkId &&
  isFirstPartOfHunk(segment, partIndex)

const isEditingHunkOtherPart = (part: RenderedPart): boolean =>
  part.hunkId !== undefined && reviewStore.editingHunkId === part.hunkId

onMounted(() => {
  // Takes keyboard focus away from the (neutralized) contenteditable editor.
  overlayRef.value?.focus()
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

/* Rendered markdown fragments bring their own <p> margins (user-agent
   default ~1em top/bottom); left alone, that stacks with .review-part's
   own margin and inflates the gap around every diff block. Reset them and
   let .review-segment/.review-part control spacing explicitly instead. */
.review-document :deep(p) {
  margin: 0;
}

.review-segment + .review-region,
.review-region + .review-segment,
.review-segment + .review-segment {
  margin-top: 8px;
}

.review-part {
  position: relative;
  border-radius: 3px;
  padding: 2px 8px;
  margin: 1px 0;
}

.review-region:hover :deep(.review-hunk-controls),
.review-region.active :deep(.review-hunk-controls) {
  opacity: 1;
  pointer-events: auto;
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
