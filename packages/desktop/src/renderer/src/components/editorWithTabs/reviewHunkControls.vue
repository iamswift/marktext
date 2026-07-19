<template>
  <div class="review-hunk-controls">
    <button
      class="control accept"
      :title="t('review.acceptHint')"
      @click.stop="accept"
    >
      {{ t('review.accept') }}
    </button>
    <button
      class="control reject"
      :title="t('review.rejectHint')"
      @click.stop="reject"
    >
      {{ t('review.reject') }}
    </button>
    <button
      class="control edit"
      :title="t('review.editHint')"
      @click.stop="edit"
    >
      {{ t('review.edit') }}
    </button>
    <button
      class="control toggle-view"
      :title="t('review.toggleViewHint')"
      @click.stop="toggleView"
    >
      {{ toggleLabel }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useReviewStore } from '@/store/review'
import { t } from '../../i18n'

const props = defineProps<{ hunkId: string }>()

const reviewStore = useReviewStore()

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
.review-hunk-controls {
  position: absolute;
  top: -12px;
  right: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
  z-index: 2;
}

.control {
  font-size: 12px;
  line-height: 1;
  padding: 4px 10px;
  border-radius: 3px;
  border: 1px solid var(--editorColor30, rgba(128, 128, 128, 0.3));
  background: var(--floatBgColor, var(--editorBgColor));
  color: var(--editorColor);
  cursor: pointer;
}

.control:hover {
  border-color: var(--themeColor);
  color: var(--themeColor);
}

.control.accept:hover {
  border-color: var(--diffAddedWordBg, rgba(70, 180, 100, 0.6));
  color: inherit;
  background: var(--diffAddedBg, rgba(70, 180, 100, 0.14));
}

.control.reject:hover {
  border-color: var(--diffDeletedWordBg, rgba(220, 80, 80, 0.6));
  color: inherit;
  background: var(--diffDeletedBg, rgba(220, 80, 80, 0.14));
}
</style>
