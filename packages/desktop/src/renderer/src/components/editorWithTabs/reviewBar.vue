<template>
  <div class="review-bar">
    <div class="review-bar-status">
      <span
        v-if="reviewStore.baselineWasUnsaved"
        class="review-unsaved-banner"
      >
        {{ t('review.unsavedBaselineBanner') }}
      </span>
      <span class="review-count">
        {{
          reviewStore.remainingCount > 0
            ? t('review.remainingCount', { count: reviewStore.remainingCount })
            : t('review.allDecided')
        }}
      </span>
    </div>
    <div class="review-bar-actions">
      <button
        class="control nav"
        :disabled="reviewStore.remainingCount === 0"
        :title="t('review.prev')"
        @click="reviewStore.focusPrev()"
      >
        &#8593;
      </button>
      <button
        class="control nav"
        :disabled="reviewStore.remainingCount === 0"
        :title="t('review.next')"
        @click="reviewStore.focusNext()"
      >
        &#8595;
      </button>
      <button
        class="control accept-all"
        :disabled="reviewStore.remainingCount === 0"
        @click="acceptAll"
      >
        {{ t('review.acceptAll') }}
      </button>
      <button
        class="control reject-all"
        :disabled="reviewStore.remainingCount === 0"
        @click="rejectAll"
      >
        {{ t('review.rejectAll') }}
      </button>
      <button
        class="control exit"
        @click="reviewStore.requestExit()"
      >
        {{ t('review.exit') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useReviewStore } from '@/store/review'
import { t } from '../../i18n'

const reviewStore = useReviewStore()

const acceptAll = (): void => {
  reviewStore.acceptAll().catch(console.error)
}
const rejectAll = (): void => {
  reviewStore.rejectAll().catch(console.error)
}
</script>

<style scoped>
.review-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 16px;
  background: var(--floatBgColor, var(--editorBgColor));
  border-bottom: 1px solid var(--editorColor30, rgba(128, 128, 128, 0.3));
  font-size: 13px;
}

.review-bar-status {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  overflow: hidden;
}

.review-unsaved-banner {
  color: var(--notificationWarningColor, inherit);
  background: var(--notificationWarningBg, transparent);
  padding: 2px 8px;
  border-radius: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.review-count {
  white-space: nowrap;
  opacity: 0.85;
}

.review-bar-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
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

.control:hover:not(:disabled) {
  border-color: var(--themeColor);
  color: var(--themeColor);
}

.control:disabled {
  opacity: 0.4;
  cursor: default;
}

.control.nav {
  padding: 4px 8px;
}

.control.exit {
  border-color: var(--themeColor);
  color: var(--themeColor);
}
</style>
