<template>
  <div class="review-bar">
    <div class="banner">
      <span
        v-if="reviewStore.baselineWasUnsaved"
        class="review-unsaved-banner"
      >
        {{ t('review.unsavedBaselineBanner') }}
      </span>
      {{ t('review.banner') }}
    </div>
    <div class="review-bar-status">
      <span class="review-count progress">
        <span class="done">{{ reviewStore.decidedCount }}</span>
        {{ t('review.progressOf', { total: reviewStore.hunks.length }) }}
      </span>
    </div>
    <div class="review-bar-actions">
      <button
        v-if="reviewStore.lastDecidedUnit"
        class="control undo-last"
        :title="t('review.undoLastHint')"
        @click="undoLast"
      >
        {{ t('review.undoLast') }}
      </button>
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
    <div
      class="track"
      role="progressbar"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="trackAriaValueNow"
      :aria-label="trackAriaLabel"
    >
      <i :style="{ width: `${progressPercent}%` }" />
      <span
        v-if="partialPercent > 0"
        class="partial"
        :style="{ left: `${progressPercent}%`, width: `${partialPercent}%` }"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useReviewStore } from '@/store/review'
import { t } from '../../i18n'

const reviewStore = useReviewStore()

const progressPercent = computed(() => {
  const total = reviewStore.hunks.length
  return total === 0 ? 0 : Math.round((reviewStore.decidedCount / total) * 100)
})

// Extra credit toward the track's fill for a hunk that is only partway
// through its correlated runs — rendered as a visually distinct segment
// appended after progressPercent so a paragraph mid-triage moves the track
// instead of sitting flush with the untouched hunks around it.
const partialFraction = computed(() => {
  const total = reviewStore.hunks.length
  if (total === 0) {
    return 0
  }
  const sum = reviewStore.hunks.reduce((acc, hunk) => {
    if (reviewStore.isHunkDecided(hunk.id)) {
      return acc
    }
    const { decided, decidable } = reviewStore.hunkRunProgress(hunk.id)
    return decidable > 0 ? acc + decided / decidable : acc
  }, 0)
  return sum / total
})

const partialPercent = computed(() => Math.round(partialFraction.value * 100))

const partialHunkCount = computed(() =>
  reviewStore.hunks.filter((hunk) => {
    if (reviewStore.isHunkDecided(hunk.id)) {
      return false
    }
    const { decided, decidable } = reviewStore.hunkRunProgress(hunk.id)
    return decidable > 0 && decided > 0
  }).length
)

const trackAriaValueNow = computed(() => Math.min(100, progressPercent.value + partialPercent.value))

const trackAriaLabel = computed(() =>
  partialHunkCount.value > 0
    ? t('review.trackProgressPartial', {
      done: reviewStore.decidedCount,
      total: reviewStore.hunks.length,
      partial: partialHunkCount.value
    })
    : t('review.trackProgress', {
      done: reviewStore.decidedCount,
      total: reviewStore.hunks.length
    })
)

const acceptAll = (): void => {
  reviewStore.acceptAll().catch(console.error)
}
const rejectAll = (): void => {
  reviewStore.rejectAll().catch(console.error)
}
const undoLast = (): void => {
  const unit = reviewStore.lastDecidedUnit
  if (!unit) {
    return
  }
  if (unit.runIndex !== undefined) {
    reviewStore.revertRun(unit.hunkId, unit.runIndex).catch(console.error)
  } else if (unit.filledRuns) {
    reviewStore.revertFilledRuns(unit.hunkId, unit.filledRuns).catch(console.error)
  } else {
    reviewStore.undecide(unit.hunkId).catch(console.error)
  }
}
</script>

<style scoped>
/* Grid rather than a single flex row: the banner spans the full width above,
   and the progress track spans it below, with status and actions sharing the
   middle row. */
.review-bar {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  gap: 6px 12px;
  padding: 8px 16px;
  background: var(--floatBgColor, var(--editorBgColor));
  border-bottom: 1px solid var(--editorColor30, rgba(128, 128, 128, 0.3));
  font-size: 13px;
}

.banner {
  grid-column: 1 / -1;
  color: var(--editorColor60, rgba(128, 128, 128, 0.75));
  min-width: 0;
}

.track {
  grid-column: 1 / -1;
  position: relative;
  height: 5px;
  border-radius: 3px;
  background: var(--editorColor10, rgba(128, 128, 128, 0.15));
  overflow: hidden;
}

.track > i {
  display: block;
  height: 100%;
  background: var(--themeColor);
  transition: width 0.25s ease;
}

/*
 * The partial-credit segment for hunks with some but not all runs decided
 * (US-015). Positioned to pick up right where the solid `i` fill ends, and
 * given a diagonal hatch rather than a plain lighter tint so the "in
 * progress" state still reads at a glance for a viewer who can't rely on
 * hue/opacity alone.
 */
.track > .partial {
  position: absolute;
  top: 0;
  height: 100%;
  background:
    repeating-linear-gradient(
      135deg,
      var(--themeColor) 0,
      var(--themeColor) 2px,
      transparent 2px,
      transparent 4px
    ),
    var(--themeColor30);
  transition: width 0.25s ease, left 0.25s ease;
}

.review-bar-status {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  overflow: hidden;
}

.progress {
  font-weight: 600;
  opacity: 1;
}

.progress .done {
  color: var(--themeColor);
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
