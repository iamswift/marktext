<template>
  <div
    class="sug-card"
    :class="{ editing }"
    :data-hunk="hunkId"
    role="group"
    :aria-label="kindText"
  >
    <div class="kind">
      <span
        v-if="ordinal"
        class="ordinal"
      >#{{ ordinal }} · </span>{{ kindText }}
    </div>

    <template v-if="editing">
      <div class="status edited">
        {{ t('review.cardEditing') }}
      </div>
      <div class="delta">
        <span class="arrow">{{ t('review.cardEditingHint') }}</span>
      </div>
    </template>

    <template v-else>
      <div
        v-if="delta"
        class="delta"
      >
        <template v-if="delta.kind === 'replace'">
          <span class="old">{{ delta.oldText }}</span>
          <span class="arrow">→</span>
          <span class="new">{{ delta.newText }}</span>
        </template>
        <span
          v-else-if="delta.kind === 'preview'"
          :class="delta.side"
        >“{{ delta.text }}{{ delta.truncated ? '…' : '' }}”</span>
        <span
          v-else
          class="new"
        >{{ bulkText(delta.lines) }}</span>
      </div>

      <div class="sug-actions">
        <button
          class="act keep accept"
          :title="t('review.acceptHint')"
          @click.stop="accept"
        >
          ✓ {{ t('review.keep') }}
        </button>
        <button
          class="act undo reject"
          :title="t('review.rejectHint')"
          @click.stop="reject"
        >
          ↺ {{ t('review.undo') }}
        </button>
        <button
          class="act ghost edit"
          :title="t('review.editHint')"
          @click.stop="edit"
        >
          ✎
        </button>
      </div>

      <div class="sug-actions view-row">
        <button
          class="act ghost toggle-view"
          :title="t('review.toggleViewHint')"
          @click.stop="toggleView"
        >
          {{ toggleLabel }}
        </button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { describeHunk, summarizeHunk } from 'common/diff/summarize'
import { useReviewStore } from '@/store/review'
import { t } from '../../i18n'

const props = defineProps<{
  hunkId: string
  /** Set only when this cell holds several cards, to pair each with its text. */
  ordinal?: number
}>()

const reviewStore = useReviewStore()

const hunk = computed(() => reviewStore.hunks.find((candidate) => candidate.id === props.hunkId))
const editing = computed(() => reviewStore.editingHunkId === props.hunkId)
const delta = computed(() => (hunk.value ? summarizeHunk(hunk.value) : null))

// Singular and plural are separate keys: vue-i18n plural parsing is disabled
// in this app's config, so the "a | b" form would not compile.
const kindText = computed(() => {
  if (!hunk.value) {
    return ''
  }
  const kind = describeHunk(hunk.value)
  switch (kind.key) {
    case 'wordsFixed':
      return kind.count === 1
        ? t('review.kindWordFixed')
        : t('review.kindWordsFixed', { count: kind.count })
    case 'paragraphsRevised':
      return kind.count === 1
        ? t('review.kindParagraphRevised')
        : t('review.kindParagraphsRevised', { count: kind.count })
    case 'sentenceRewritten':
      return t('review.kindSentenceRewritten')
    case 'paragraphAdded':
      return kind.count === 1
        ? t('review.kindParagraphAdded')
        : t('review.kindParagraphsAdded', { count: kind.count })
    case 'paragraphRemoved':
      return kind.count === 1
        ? t('review.kindParagraphRemoved')
        : t('review.kindParagraphsRemoved', { count: kind.count })
    default:
      return kind.count === 1
        ? t('review.kindLineChanged')
        : t('review.kindLinesChanged', { count: kind.count })
  }
})

const bulkText = (lines: number): string =>
  lines === 1
    ? t('review.cardLineRewritten')
    : t('review.cardLinesRewritten', { count: lines })

// Names the view the button switches TO, not the one currently showing.
const toggleLabel = computed(() =>
  reviewStore.viewFor(props.hunkId) === 'inline'
    ? t('review.viewStacked')
    : t('review.viewInline')
)

const accept = (): void => {
  reviewStore.decide(props.hunkId, { kind: 'accept' }).catch(console.error)
}
const reject = (): void => {
  reviewStore.decide(props.hunkId, { kind: 'reject' }).catch(console.error)
}
const edit = (): void => {
  reviewStore.beginEdit(props.hunkId)
}
const toggleView = (): void => {
  reviewStore.toggleView(props.hunkId)
}
</script>

<style scoped>
/* The left rail is the card's state indicator. Only the pending colour is
   reachable today: a decided hunk melts into context and its card goes with
   it (see the plan's "settled cards" analysis). */
.sug-card {
  border: 1px solid var(--reviewCardBorder, var(--editorColor30, rgba(128, 128, 128, 0.3)));
  border-left: 3px solid var(--reviewCardRailPending, rgba(127, 166, 207, 0.85));
  border-radius: 10px;
  background: var(--reviewCardBg, var(--floatBgColor, var(--editorBgColor)));
  padding: 10px 12px;
  /* Spacing lives here, not on .card-cell: with row-gap 0 an empty cell with
     bottom padding would set a min row height and add a phantom gap after
     every unchanged paragraph. */
  margin-bottom: 14px;
  font-size: 13.5px;
  line-height: 1.45;
  box-shadow: var(--reviewCardShadow, 0 1px 3px rgba(0, 0, 0, 0.1));
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}

.sug-card:hover {
  border-color: var(--reviewCardHoverBorder, rgba(146, 179, 216, 0.9));
  box-shadow: var(--reviewCardHoverShadow, 0 2px 8px rgba(51, 97, 143, 0.18));
}

.kind {
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.09em;
  text-transform: uppercase;
  color: var(--reviewCardKindColor, var(--editorColor60, rgba(128, 128, 128, 0.75)));
  margin-bottom: 4px;
}

.delta {
  margin-bottom: 8px;
  overflow-wrap: anywhere;
}

.delta .old,
.delta .preview-old {
  text-decoration: line-through;
  color: var(--diffDeletedInk, rgba(180, 70, 80, 0.95));
}

.delta .arrow {
  color: var(--editorColor60, rgba(128, 128, 128, 0.75));
  padding: 0 4px;
}

.delta .new {
  color: var(--diffAddedInk, rgba(60, 122, 73, 0.95));
  font-weight: 600;
}

.delta .old:only-child {
  /* A pure-deletion preview renders a lone .old span. */
  display: inline;
}

.status {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}

.status.edited {
  color: var(--themeColor);
}

.sug-actions {
  display: flex;
  gap: 6px;
}

.sug-actions.view-row {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--reviewCardDivider, var(--editorColor10, rgba(128, 128, 128, 0.2)));
}

.act {
  font-size: 12px;
  line-height: 1.4;
  padding: 3px 9px;
  border-radius: 7px;
  border: 1px solid var(--editorColor30, rgba(128, 128, 128, 0.3));
  background: transparent;
  color: var(--editorColor);
  cursor: pointer;
}

.act:hover {
  border-color: var(--themeColor);
  color: var(--themeColor);
}

.act.keep:hover {
  border-color: var(--diffAddedWordBg, rgba(70, 180, 100, 0.6));
  color: inherit;
  background: var(--diffAddedBg, rgba(70, 180, 100, 0.14));
}

.act.undo:hover {
  border-color: var(--diffDeletedWordBg, rgba(220, 80, 80, 0.6));
  color: inherit;
  background: var(--diffDeletedBg, rgba(220, 80, 80, 0.14));
}

.act.ghost {
  border-color: transparent;
  color: var(--editorColor60, rgba(128, 128, 128, 0.75));
}

.act.ghost:hover {
  border-color: var(--editorColor30, rgba(128, 128, 128, 0.3));
  color: var(--editorColor);
}
</style>
