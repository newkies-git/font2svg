<script setup lang="ts">
import type { LayerRecord } from '../../../shared/types.ts'

defineProps<{
  editableLayer: LayerRecord | null
  locked: boolean
  hasFont: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  reverseMedian: []
  resegment: []
}>()
</script>

<template>
  <button
    type="button"
    class="bar-btn"
    :disabled="locked || busy || !editableLayer?.strokes.length"
    title="선택 획의 기필(시작점)과 수필(끝점) 방향을 반전합니다"
    @click="emit('reverseMedian')"
  >
    기필↔수필 반전
  </button>
  <button
    v-if="hasFont"
    type="button"
    class="bar-btn"
    :disabled="locked || busy || !editableLayer?.strokes.length"
    title="현재 중심선을 기준으로 궁서체 윤곽을 다시 획별로 분할합니다. 정밀 지정 시 캔버스 돋보기를 활용하세요."
    @click="emit('resegment')"
  >
    윤곽 재분할
  </button>
  <span class="knife-inline-pill" role="status" title="중심선·베지어·칼·윤곽연결 도구에서 커서 주변을 확대합니다">돋보기 ON</span>
</template>
