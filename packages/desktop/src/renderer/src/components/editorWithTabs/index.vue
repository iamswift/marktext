<template>
  <div
    class="editor-with-tabs"
    :style="{ 'max-width': `calc(100vw - ${effectiveSideBarWidth}px)` }"
  >
    <tabs v-show="showTabBar" />
    <div class="container">
      <editor
        :markdown="markdown"
        :cursor="cursor"
        :text-direction="textDirection"
        :platform="platform"
      />
      <source-code
        v-if="sourceCode"
        :markdown="markdown"
        :muya-index-cursor="muyaIndexCursor"
        :text-direction="textDirection"
      />
      <div
        v-if="reviewVisible"
        class="review-container"
      >
        <review-bar />
        <review-overlay />
      </div>
    </div>
    <tab-notifications />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore } from '@/store/editor'
import { useLayoutStore } from '@/store/layout'
import { useReviewStore } from '@/store/review'
import { storeToRefs } from 'pinia'
import Tabs from './tabs.vue'
import Editor from './editor.vue'
import SourceCode from './sourceCode.vue'
import TabNotifications from './notifications.vue'
import ReviewOverlay from './reviewOverlay.vue'
import ReviewBar from './reviewBar.vue'

defineProps<{
  markdown: string
  // `cursor` originates as `IFileState.cursor` which is `unknown`
  // (see src/shared/types/files.ts); align here instead of forcing every
  // caller to widen.
  cursor: unknown
  muyaIndexCursor?: unknown
  sourceCode: boolean
  showTabBar: boolean
  textDirection: string
  platform: string
}>()

const { effectiveSideBarWidth } = storeToRefs(useLayoutStore())

const editorStore = useEditorStore()
const reviewStore = useReviewStore()
const reviewVisible = computed(
  () => reviewStore.active && reviewStore.tabId === editorStore.currentFile?.id
)
</script>

<style scoped>
.editor-with-tabs {
  position: relative;
  height: 100%;
  flex: 1;
  display: flex;
  flex-direction: column;

  overflow: hidden;
  background: var(--editorBgColor);
  & > .container {
    /* Positioning context for the absolutely-positioned .review-container
       below, so it fills only the area under the tab bar rather than the
       whole .editor-with-tabs (which would overlap the tabs — visible on
       narrow screens). */
    position: relative;
    flex: 1;
    overflow: hidden;
  }
}

.review-container {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
}
</style>
