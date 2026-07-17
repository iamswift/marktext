<template>
  <div class="review-hunk-editor">
    <textarea
      ref="textareaRef"
      v-model="text"
      class="editor-area"
      spellcheck="false"
      @keydown.esc.stop.prevent="cancel"
      @keydown.ctrl.enter.stop.prevent="confirm"
      @input="autoGrow"
    />
    <div class="editor-actions">
      <button
        class="control confirm"
        @click.stop="confirm"
      >
        {{ t('review.confirmEdit') }}
      </button>
      <button
        class="control cancel"
        @click.stop="cancel"
      >
        {{ t('review.cancelEdit') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue'
import { useReviewStore } from '@/store/review'
import { t } from '../../i18n'

const props = defineProps<{ hunkId: string }>()

const reviewStore = useReviewStore()
const textareaRef = ref<HTMLTextAreaElement | null>(null)

const proposedText = (): string => {
  const hunk = reviewStore.hunks.find((h) => h.id === props.hunkId)
  return hunk ? hunk.proposedLines.join('\n') : ''
}
const text = ref(proposedText())

const autoGrow = (): void => {
  const el = textareaRef.value
  if (el) {
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight + 2}px`
  }
}

const confirm = (): void => {
  reviewStore.confirmEdit(props.hunkId, text.value).catch(console.error)
}

const cancel = (): void => {
  reviewStore.cancelEdit()
}

onMounted(() => {
  nextTick(() => {
    autoGrow()
    textareaRef.value?.focus()
  })
})
</script>

<style scoped>
.review-hunk-editor {
  margin: 4px 0;
}

.editor-area {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  min-height: 2.2em;
  font-family: var(--editorCodeFontFamily, monospace);
  font-size: 13px;
  line-height: 1.5;
  color: var(--editorColor);
  background: var(--inputBgColor, var(--editorBgColor));
  border: 1px solid var(--themeColor);
  border-radius: 3px;
  padding: 6px 8px;
  outline: none;
}

.editor-actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
}

.control {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 3px;
  border: 1px solid var(--editorColor30, rgba(128, 128, 128, 0.3));
  background: var(--floatBgColor, var(--editorBgColor));
  color: var(--editorColor);
  cursor: pointer;
}

.control.confirm {
  border-color: var(--themeColor);
  color: var(--themeColor);
}

.control:hover {
  border-color: var(--themeColor);
}
</style>
