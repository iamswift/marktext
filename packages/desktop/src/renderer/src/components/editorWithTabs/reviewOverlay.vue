<template>
  <div
    ref="overlayRef"
    class="review-overlay"
    tabindex="0"
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
          <div
            v-for="(part, partIndex) in segment.parts"
            :key="partIndex"
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
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { renderToStaticHTML } from '@muyajs/core'
import { annotateMerged, computeRegions } from 'common/diff/regions'
import { useReviewStore } from '@/store/review'
import { applyWordMarks } from '@/util/reviewWordMarks'
import ReviewHunkControls from './reviewHunkControls.vue'

interface RenderedPart {
  role: 'context' | 'deleted' | 'added'
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
        applyWordMarks(deletedEl, addedEl)
        deleted.html = deletedEl.innerHTML
        added.html = addedEl.innerHTML
      } catch {
        // Word marks are progressive enhancement; the block tint remains.
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

onMounted(() => {
  // Takes keyboard focus away from the (neutralized) contenteditable editor.
  overlayRef.value?.focus()
})
</script>

<style scoped>
.review-overlay {
  position: absolute;
  inset: 0;
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

.review-part {
  position: relative;
  border-radius: 3px;
  padding: 2px 8px;
  margin: 2px 0;
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
