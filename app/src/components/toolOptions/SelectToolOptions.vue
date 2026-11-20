<script setup lang="ts">
import { LAYER_ID } from '../../../shared/constants.ts'
import type { TransformMode } from '../../lib/transformMath.ts'
import type { EditorTool, LayerRecord } from '../../../shared/types.ts'

const props = defineProps<{
  tool: EditorTool
  scope: 'layer' | 'stroke'
  transformMode: TransformMode
  editableLayer: LayerRecord | null
  locked: boolean
  hasFont: boolean
  dirty: boolean
  busy: boolean
  selectedPathPointCount: number
  canEditPathPoints: boolean
  canDeletePathPoints: boolean
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
  selectTool: [tool: EditorTool]
  autoFit: []
  resetEdits: []
  insertPathPoint: []
  togglePathCurve: []
  simplifyPathPoints: []
  deletePathPoints: []
  clearPathPoints: []
}>()

function pickTransformMode(mode: TransformMode) {
  emit('changeTransformMode', mode)
  if (props.tool !== 'select') emit('selectTool', 'select')
}
</script>

<template>
  <div v-if="tool === 'select'" class="seg-control" role="group" aria-label="변환 대상 범위">
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
      :class="{ on: tool === 'select' && transformMode === m.mode }"
      :aria-pressed="tool === 'select' && transformMode === m.mode"
      :title="m.hint"
      @click="pickTransformMode(m.mode)"
    >
      {{ m.label }}
    </button>
    <button
      type="button"
      :class="{ on: tool === 'bezier' }"
      :aria-pressed="tool === 'bezier'"
      title="SVG 패스 정점을 활성화해 특정 영역의 점들을 드래그 선택·이동·추가·삭제·곡선 변환합니다 (A)"
      @click="emit('selectTool', 'bezier')"
    >
      정점
    </button>
  </div>
  <template v-if="tool === 'select'">
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
  </template>
  <template v-else-if="tool === 'bezier'">
    <button
      v-if="selectedPathPointCount > 0"
      type="button"
      class="bar-btn path-point-badge"
      title="선택된 패스 정점 해제 (Esc)"
      @click="emit('clearPathPoints')"
    >
      {{ selectedPathPointCount }}점 ×
    </button>
    <button
      type="button"
      class="bar-btn"
      :disabled="locked || busy || !canEditPathPoints"
      title="선택 정점 구간(또는 가장 긴 구간)에 새 정점을 추가합니다. 윤곽선 더블클릭으로도 원하는 위치에 추가할 수 있습니다."
      @click="emit('insertPathPoint')"
    >
      + 점
    </button>
    <button
      type="button"
      class="bar-btn"
      :disabled="locked || busy || selectedPathPointCount === 0"
      title="선택한 정점 구간의 직선(L)과 베지어 곡선(C)을 전환합니다"
      @click="emit('togglePathCurve')"
    >
      곡선
    </button>
    <button
      type="button"
      class="bar-btn"
      :disabled="locked || busy || !canEditPathPoints"
      title="선택 영역(3점 이상) 또는 전체 획의 촘촘한 직선 정점을 정리합니다(곡선은 유지)"
      @click="emit('simplifyPathPoints')"
    >
      단순화
    </button>
    <button
      type="button"
      class="bar-btn"
      :disabled="locked || busy || !canDeletePathPoints"
      title="선택한 패스 정점을 삭제합니다 (Delete / Alt+클릭 / 우클릭)"
      @click="emit('deletePathPoints')"
    >
      삭제
    </button>
  </template>
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
