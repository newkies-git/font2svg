<script setup lang="ts">
import type { Pt } from '../../../shared/types.ts'
import { MIN_BRIDGE_POINTS, MIN_CONNECT_POINTS } from '../../composables/useConnectTool.ts'

defineProps<{
  connectPoints: Pt[]
  locked: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  cancelConnect: []
  undoConnect: []
  commitConnect: []
  commitBridge: []
}>()
</script>

<template>
  <span class="knife-inline-pill" role="status">
    <template v-if="connectPoints.length === 0">시작점 클릭</template>
    <template v-else-if="connectPoints.length < MIN_CONNECT_POINTS">{{ connectPoints.length }}점 — 교차 연결</template>
    <template v-else>{{ connectPoints.length }}점 — 교차 연결 또는 Enter</template>
  </span>
  <button
    type="button"
    class="bar-btn"
    :disabled="locked || busy || connectPoints.length < MIN_BRIDGE_POINTS"
    title="찍은 끝점(과 중간점) 사이의 짧은 윤곽을 베지어로 바꿉니다. 자동 매핑이 교차 끝점을 못 찾을 때 씁니다."
    @click="emit('commitBridge')"
  >
    교차 연결
  </button>
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
