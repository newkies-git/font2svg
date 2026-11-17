<script setup lang="ts">
import type { Pt } from '../../../shared/types.ts'
import { MIN_CONNECT_POINTS } from '../../composables/useConnectTool.ts'

defineProps<{
  connectPoints: Pt[]
  locked: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  cancelConnect: []
  undoConnect: []
  commitConnect: []
}>()
</script>

<template>
  <span class="knife-inline-pill" role="status">
    <template v-if="connectPoints.length === 0">시작점 클릭</template>
    <template v-else>{{ connectPoints.length }}점 — Enter 연결</template>
  </span>
  <button
    type="button"
    class="bar-btn"
    :disabled="locked || busy || connectPoints.length < MIN_CONNECT_POINTS"
    title="지정한 시작·중간·끝점으로 닫힌 윤곽을 만듭니다 (Enter)"
    @click="emit('commitConnect')"
  >
    윤곽 연결
  </button>
  <button
    type="button"
    class="bar-btn"
    :disabled="connectPoints.length === 0"
    title="마지막 점 되돌리기 (⌫)"
    @click="emit('undoConnect')"
  >
    점 되돌리기
  </button>
  <button
    v-if="connectPoints.length"
    type="button"
    class="bar-btn"
    @click="emit('cancelConnect')"
  >
    취소 (Esc)
  </button>
</template>
