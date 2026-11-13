<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ title: string }>()

const dialog = ref<HTMLDialogElement | null>(null)
let resolveAsk: ((value: boolean) => void) | null = null

function ask(): Promise<boolean> {
  return new Promise((resolve) => {
    resolveAsk = resolve
    dialog.value?.showModal()
  })
}

function onClose() {
  resolveAsk?.(dialog.value?.returnValue === 'confirm')
  resolveAsk = null
}

defineExpose({ ask })
</script>

<template>
  <dialog
    ref="dialog"
    class="app-dialog"
    aria-labelledby="confirm-dialog-title"
    aria-describedby="confirm-dialog-desc"
    @close="onClose"
  >
    <div class="dialog-content">
      <h3 id="confirm-dialog-title">{{ title }}</h3>
      <p id="confirm-dialog-desc"><slot /></p>
      <form method="dialog" class="dialog-actions">
        <button type="submit" value="cancel" autofocus>취소</button>
        <button type="submit" value="confirm" class="primary">적용하기</button>
      </form>
    </div>
  </dialog>
</template>
