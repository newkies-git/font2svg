<script setup lang="ts">
import { LAYER_ID } from '../../../shared/constants.ts'
import type { TransformMode } from '../../lib/transformMath.ts'
import type { LayerRecord } from '../../../shared/types.ts'

defineProps<{
  scope: 'layer' | 'stroke'
  transformMode: TransformMode
  editableLayer: LayerRecord | null
  locked: boolean
  hasFont: boolean
  dirty: boolean
  busy: boolean
}>()

const TRANSFORM_MODES: { mode: TransformMode; label: string; hint: string }[] = [
  { mode: 'scale', label: '크기', hint: '8방향 핸들로 크기를 조절합니다 (Shift: 비율 유지)' },
  { mode: 'rotate', label: '회전', hint: '모서리 핸들을 끌어 중심을 기준으로 회전합니다 (Shift: 15° 단위)' },
  { mode: 'skew', label: '기울임', hint: '변 중앙 핸들을 끌어 반대편 변을 고정한 채 기울입니다' },
  { mode: 'distort', label: '왜곡', hint: '모서리 하나만 옮겨 사다리꼴·비틀림 모양으로 맞춥니다' },
]

const emit = defineEmits<{
  changeScope: [scope: 'layer' | 'stroke']
  changeTransformMode: [mode: TransformMode]
  autoFit: []
  resetEdits: []
}>()
</script>

<template>
  <div class="seg-control" role="group" aria-label="변환 대상 범위">
    <button
      type="button"
      :class="{ on: scope === 'layer' }"
      :aria-pressed="scope === 'layer'"
      @click="emit('changeScope', 'layer')"
    >
      전체 변환
    </button>
    <button
      type="button"
      :class="{ on: scope === 'stroke' }"
      :aria-pressed="scope === 'stroke'"
      @click="emit('changeScope', 'stroke')"
    >
      단일 획 변환
    </button>
  </div>
  <div class="seg-control" role="group" aria-label="변형 방식">
    <button
      v-for="m in TRANSFORM_MODES"
      :key="m.mode"
      type="button"
      :class="{ on: transformMode === m.mode }"
      :aria-pressed="transformMode === m.mode"
      :title="m.hint"
      @click="emit('changeTransformMode', m.mode)"
    >
      {{ m.label }}
    </button>
  </div>
  <button
    v-if="hasFont && editableLayer && editableLayer.id !== LAYER_ID.font"
    type="button"
    class="bar-btn"
    :disabled="locked || busy"
    :title="scope === 'stroke'
      ? '선택한 획의 윤곽을 그 획이 맡은 궁서체 모양으로 바꿉니다. 중심선 점은 그 모양을 따르게 다시 잡습니다. 궁서체 자체는 움직이지 않습니다.'
      : '각 획의 윤곽을 그 획이 맡은 궁서체 모양으로 바꿉니다. 중심선 점은 그 모양을 따르게 다시 잡습니다. 궁서체 자체는 움직이지 않습니다.'"
    @click="emit('autoFit')"
  >
    자동 맞춤
  </button>
  <button
    v-if="editableLayer && editableLayer.id !== LAYER_ID.font"
    type="button"
    class="bar-btn"
    :disabled="locked || busy || !dirty"
    title="미저장 맞춤·이동 등 편집을 취소하고, 이 레이어를 마지막으로 불러온(또는 저장한) 상태로 되돌립니다"
    @click="emit('resetEdits')"
  >
    초기화
  </button>
</template>
