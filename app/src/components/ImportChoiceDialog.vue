<script setup lang="ts">
import { ref } from 'vue'

const dialog = ref<HTMLDialogElement | null>(null)
let resolveAsk: ((value: 'replace' | 'append' | null) => void) | null = null

function ask(): Promise<'replace' | 'append' | null> {
  return new Promise((resolve) => {
    resolveAsk = resolve
    dialog.value?.showModal()
  })
}

function onClose() {
  const value = dialog.value?.returnValue
  resolveAsk?.(value === 'replace' || value === 'append' ? value : null)
  resolveAsk = null
}

defineExpose({ ask })
</script>

<template>
  <dialog
    ref="dialog"
    class="app-dialog"
    aria-labelledby="import-choice-title"
    aria-describedby="import-choice-desc"
    @close="onClose"
  >
    <div class="dialog-content">
      <h3 id="import-choice-title">작업 획으로 가져오기</h3>
      <p id="import-choice-desc"><slot /></p>
      <form method="dialog" class="dialog-actions">
        <button type="submit" value="cancel" autofocus>취소</button>
        <button type="submit" value="append">추가</button>
        <button type="submit" value="replace" class="primary">초기화 후 쓰기</button>
      </form>
    </div>
  </dialog>
</template>
