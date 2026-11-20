<script setup lang="ts">
import { isContourLayer, isReferenceKind } from '../../shared/layerKind.ts'
import { computed, ref, watch } from 'vue'
import { useCanvasDrag, type ResizeDir } from '../composables/useCanvasDrag.ts'
import { useCanvasFit, visibleWorkStrokes } from '../composables/useCanvasFit.ts'
import { useCanvasLoupe } from '../composables/useCanvasLoupe.ts'
import { BADGE_RADIUS, CANVAS } from '../../shared/constants.ts'
import { handleDirsFor, handlePoint, type TransformMode } from '../lib/transformMath.ts'
import { pathsBBox, strokesBBox, type BBox } from '../lib/vectorEdit.ts'
import { bezierNodesOf, polylinePoints, strokeDash } from '../lib/canvasGeometry.ts'
import { FULL_CANVAS_VIEW, isFullView, panView, viewFromSelection, zoomViewAt, type CanvasView } from '../lib/canvasView.ts'
import type { CharacterDetail, EditorTool, LayerRecord, Pt, StrokeRecord } from '../../shared/types.ts'
import { MIN_CONNECT_POINTS } from '../composables/useConnectTool.ts'
import BezierOverlay from './canvasOverlays/BezierOverlay.vue'
import ConnectOverlay from './canvasOverlays/ConnectOverlay.vue'
import KnifeOverlay from './canvasOverlays/KnifeOverlay.vue'
import LoupeOverlay from './canvasOverlays/LoupeOverlay.vue'
import MedianEditOverlay from './canvasOverlays/MedianEditOverlay.vue'
import TransformOverlay from './canvasOverlays/TransformOverlay.vue'

const props = defineProps<{
  selected: CharacterDetail | null
  orderedLayers: LayerRecord[]
  editableLayer: LayerRecord | null
  locked: boolean
  tool: EditorTool
  scope: 'layer' | 'stroke'
  transformMode: TransformMode
  selectedIndex: number
  shown: number
  reveal: number
  knifePoints: Pt[]
  connectPoints: Pt[]
}>()

const emit = defineEmits<{
  selectItem: [index: number]
  knifePoint: [point: Pt, extend: boolean]
  connectPoint: [point: Pt]
  commitConnect: []
  transformBy: [fn: (x: number, y: number) => Pt, scaleFactor: number]
  restoreSnapshot: [strokes: StrokeRecord[], paths: string[]]
  updatePath: [index: number, path: string]
  moveMedianVertex: [strokeIdx: number, ptIdx: number, to: Pt]
  addMedianVertex: [strokeIdx: number, at: Pt]
  deleteMedianVertex: [strokeIdx: number, ptIdx: number]
}>()

const worldGroup = ref<SVGGElement | null>(null)
const { worldTransform, fontToScreen, eventToFont } = useCanvasFit(
  () => props.orderedLayers,
  () => props.shown,
  worldGroup,
)
const {
  loupeVisible,
  loupeEnabled,
  loupeLens,
  loupeZoom,
  LOUPE_RADIUS,
  onCanvasPointerMove,
  onCanvasPointerLeave,
  stepLoupeZoom,
} = useCanvasLoupe(() => props.tool, fontToScreen, eventToFont)

const svgEl = ref<SVGSVGElement | null>(null)
const view = ref<CanvasView>({ ...FULL_CANVAS_VIEW })
const zoomArmed = ref(false)
const marquee = ref<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
const zoomed = computed(() => !isFullView(view.value))
const viewBoxAttr = computed(() => `${view.value.x} ${view.value.y} ${view.value.w} ${view.value.h}`)

watch(() => props.selected?.char, () => {
  view.value = { ...FULL_CANVAS_VIEW }
  zoomArmed.value = false
  marquee.value = null
})

function clientToSvg(event: PointerEvent | WheelEvent): { x: number; y: number } | null {
  const ctm = svgEl.value?.getScreenCTM()
  if (!ctm) return null
  const pt = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse())
  return { x: pt.x, y: pt.y }
}

function toggleZoomArm() {
  zoomArmed.value = !zoomArmed.value
  marquee.value = null
}

function resetView() {
  view.value = { ...FULL_CANVAS_VIEW }
  zoomArmed.value = false
  marquee.value = null
}

function startMarquee(event: PointerEvent) {
  const origin = clientToSvg(event)
  if (!origin) return
  marquee.value = { x0: origin.x, y0: origin.y, x1: origin.x, y1: origin.y }
  const move = (moveEvent: PointerEvent) => {
    const cur = clientToSvg(moveEvent)
    if (!cur || !marquee.value) return
    marquee.value = { ...marquee.value, x1: cur.x, y1: cur.y }
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    const box = marquee.value
    marquee.value = null
    zoomArmed.value = false
    if (!box) return
    const next = viewFromSelection(box.x0, box.y0, box.x1, box.y1)
    if (next) view.value = next
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function startPan(event: PointerEvent) {
  const ctm = svgEl.value?.getScreenCTM()
  if (!ctm || ctm.a === 0 || ctm.d === 0) return
  const scaleX = ctm.a
  const scaleY = ctm.d
  const originX = event.clientX
  const originY = event.clientY
  const start = { ...view.value }
  const move = (moveEvent: PointerEvent) => {
    view.value = panView(start, (moveEvent.clientX - originX) / scaleX, (moveEvent.clientY - originY) / scaleY)
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function onZoomPointerDown(event: PointerEvent) {
  if (event.button === 1) {
    event.preventDefault()
    event.stopPropagation()
    startPan(event)
    return
  }
  if (!zoomArmed.value || event.button !== 0) return
  event.stopPropagation()
  startMarquee(event)
}

function onCanvasWheel(event: WheelEvent) {
  if (event.altKey && loupeEnabled.value && !zoomed.value && !zoomArmed.value) {
    event.preventDefault()
    stepLoupeZoom(event.deltaY)
    return
  }
  const at = clientToSvg(event)
  if (!at) return
  event.preventDefault()
  view.value = zoomViewAt(view.value, at.x, at.y, event.deltaY < 0)
}

function visibleStrokesOfWork(strokes: StrokeRecord[]): StrokeRecord[] {
  return visibleWorkStrokes(strokes, props.shown)
}

// 획 윤곽(OUTLINE) 레이어에서 선택한 획이 매핑된 궁서체 윤곽 인덱스. 궁서체 레이어에서 강조해 보여 준다.
const mappedContours = computed<Set<number>>(() => {
  const ed = props.editableLayer
  if (!ed || ed.kind !== 'OUTLINE') return new Set()
  return new Set(ed.strokes[props.selectedIndex]?.font_contours ?? [])
})

/** 중심선·번호 오버레이는 현재 편집 대상 레이어의 획만 쓴다. 표시 여부는 MEDIANS/NUMBERS 레이어 visible로만 제어한다. */
const overlayStrokes = computed<StrokeRecord[]>(() => {
  const ed = props.editableLayer
  if (!ed || ed.strokes.length === 0) return []
  if (ed.kind === 'STROKES') return visibleStrokesOfWork(ed.strokes)
  return ed.strokes
})

// 선택·변환 바운딩 박스
const activeBBox = computed<BBox | null>(() => {
  const ed = props.editableLayer
  if (!ed || !ed.visible) return null
  if (isContourLayer(ed)) {
    if (props.scope === 'stroke') {
      const p = ed.paths[props.selectedIndex]
      return p ? pathsBBox([p]) : null
    }
    return pathsBBox(ed.paths)
  }
  if (ed.strokes.length === 0) return null
  if (props.scope === 'stroke') {
    const s = ed.strokes[props.selectedIndex]
    return s ? strokesBBox([s]) : null
  }
  return strokesBBox(ed.strokes)
})

// 변형 방식에 따라 보여 줄 핸들(크기 8방향 / 회전·왜곡 모서리 / 기울임 변 중앙)
const resizeHandles = computed<{ dir: ResizeDir; x: number; y: number }[]>(() => {
  const b = activeBBox.value
  if (!b) return []
  return handleDirsFor(props.transformMode).map((dir) => {
    const [x, y] = handlePoint(b, dir)
    return { dir, x, y }
  })
})

// 베지어 편집용 파싱 결과
const targetBezierPath = computed<string | null>(() => {
  const ed = props.editableLayer
  if (!ed || props.tool !== 'bezier') return null
  if (isContourLayer(ed)) {
    return ed.paths[props.selectedIndex] ?? null
  }
  return ed.strokes[props.selectedIndex]?.outline_path ?? null
})

const bezierNodes = computed(() => bezierNodesOf(targetBezierPath.value))

const targetMedianPoints = computed<Pt[]>(() => {
  const ed = props.editableLayer
  if (!ed || props.tool !== 'median') return []
  return ed.strokes[props.selectedIndex]?.median_points ?? []
})

const {
  startMoveDrag,
  startHandleDrag,
  startBezierHandleDrag,
  onMedianVertexPointerDown,
  onMedianLinePointerDown,
} = useCanvasDrag({
  editableLayer: () => props.editableLayer,
  locked: () => props.locked,
  selectedIndex: () => props.selectedIndex,
  activeBBox: () => activeBBox.value,
  transformMode: () => props.transformMode,
  targetBezierPath: () => targetBezierPath.value,
  eventToFont,
  emit: {
    restoreSnapshot: (strokes, paths) => emit('restoreSnapshot', strokes, paths),
    transformBy: (fn, scaleFactor) => emit('transformBy', fn, scaleFactor),
    updatePath: (index, path) => emit('updatePath', index, path),
    moveMedianVertex: (strokeIdx, ptIdx, to) => emit('moveMedianVertex', strokeIdx, ptIdx, to),
    addMedianVertex: (strokeIdx, at) => emit('addMedianVertex', strokeIdx, at),
    deleteMedianVertex: (strokeIdx, ptIdx) => emit('deleteMedianVertex', strokeIdx, ptIdx),
  },
})

function onCanvasPointerDown(event: PointerEvent) {
  if (event.button !== 0) return
  const pt = eventToFont(event)
  if (!pt) return
  if (props.tool === 'knife') {
    emit('knifePoint', pt, event.shiftKey)
    return
  }
  if (props.tool === 'connect' && !props.locked) {
    emit('connectPoint', pt)
  }
}

function onCanvasDblClick(event: MouseEvent) {
  if (props.tool !== 'connect' || props.locked) return
  event.preventDefault()
  if (props.connectPoints.length >= MIN_CONNECT_POINTS) emit('commitConnect')
}

function onShapePointerDown(layerId: string, index: number, event: PointerEvent) {
  if (event.button !== 0) return
  if (props.tool === 'knife' || props.tool === 'connect') return // 칼·연결 도구는 상위 SVG 클릭으로 전달
  if (props.editableLayer?.id !== layerId) return
  event.stopPropagation()
  emit('selectItem', index)
  // 궁서체는 기준 레이어라 드래그로 위치·크기를 바꾸지 않는다.
  if (props.tool === 'select' && !props.locked && props.editableLayer?.kind !== 'FONT') {
    startMoveDrag(event)
  }
}
</script>

<template>
  <div v-if="selected" class="canvas-frame">
  <svg
    ref="svgEl"
    role="img"
    class="layer-canvas-svg"
    :data-tool="tool"
    :data-zoom="zoomArmed ? 'armed' : zoomed ? 'in' : 'full'"
    :aria-label="`${selected.char} (${selected.reading ?? ''}) 레이어 필순 편집기`"
    :viewBox="viewBoxAttr"
    tabindex="0"
    @pointerdown.capture="onZoomPointerDown"
    @pointerdown="onCanvasPointerDown"
    @pointermove="onCanvasPointerMove"
    @pointerleave="onCanvasPointerLeave"
    @wheel="onCanvasWheel"
    @dblclick="onCanvasDblClick"
  >
    <title>{{ selected.char }} {{ selected.reading ? `(${selected.reading})` : '' }} 다중 레이어 뷰어</title>

    <defs>
      <clipPath id="loupe-clip">
        <circle
          v-if="loupeLens"
          :cx="loupeLens.cx"
          :cy="loupeLens.cy"
          :r="LOUPE_RADIUS - 2"
        />
      </clipPath>
    </defs>

    <!-- 배경 격자 가이드 (캔버스 중심선 십자선) -->
    <g class="canvas-grid" aria-hidden="true">
      <line :x1="CANVAS / 2" y1="0" :x2="CANVAS / 2" :y2="CANVAS" />
      <line x1="0" :y1="CANVAS / 2" :x2="CANVAS" :y2="CANVAS / 2" />
    </g>

    <g id="canvas-world" ref="worldGroup" :transform="worldTransform">
      <template v-for="layer in orderedLayers" :key="layer.id">
        <!-- 1. 궁서체(TTF) 윤곽 레이어 -->
        <g
          v-if="layer.visible && layer.kind === 'FONT'"
          class="svg-layer layer-font"
          :data-color="layer.label_color"
          :opacity="layer.opacity"
        >
          <path
            v-for="(d, pIdx) in layer.paths"
            :key="`font-p-${pIdx}`"
            class="font-contour"
            vector-effect="non-scaling-stroke"
            :class="{
              'is-picked': editableLayer?.id === layer.id && selectedIndex === pIdx,
              'is-mapped': mappedContours.has(pIdx),
            }"
            :d="d"
            @pointerdown="onShapePointerDown(layer.id, pIdx, $event)"
          />
          <path
            v-for="(stroke, sIdx) in layer.strokes"
            :key="`font-s-${sIdx}`"
            class="font-contour"
            vector-effect="non-scaling-stroke"
            :class="{ 'is-picked': editableLayer?.id === layer.id && selectedIndex === sIdx }"
            :d="stroke.outline_path"
            @pointerdown="onShapePointerDown(layer.id, sIdx, $event)"
          />
        </g>

        <!-- 2. 레퍼런스 및 커스텀 레이어 (MMH / ACJK / NAVER / CUSTOM) -->
        <g
          v-else-if="layer.visible && (layer.kind === 'OUTLINE' || isReferenceKind(layer.kind) || layer.kind === 'CUSTOM')"
          class="svg-layer layer-ref"
          :data-color="layer.label_color"
          :opacity="layer.opacity"
        >
          <path
            v-for="(d, pIdx) in layer.paths"
            :key="`${layer.id}-p-${pIdx}`"
            class="ref-outline"
            vector-effect="non-scaling-stroke"
            :class="{ 'is-picked': editableLayer?.id === layer.id && selectedIndex === pIdx }"
            :d="d"
            @pointerdown="onShapePointerDown(layer.id, pIdx, $event)"
          />
          <path
            v-for="(stroke, sIdx) in layer.strokes"
            :key="`${layer.id}-s-${sIdx}`"
            class="ref-outline"
            vector-effect="non-scaling-stroke"
            :class="{
              'is-picked': editableLayer?.id === layer.id && selectedIndex === sIdx,
              'is-radical': stroke.is_radical,
              'is-unmapped': layer.kind === 'OUTLINE' && !stroke.font_contours?.length,
            }"
            :d="stroke.outline_path"
            @pointerdown="onShapePointerDown(layer.id, sIdx, $event)"
          />
        </g>

        <!-- 3. 최종 작업 획 레이어 (STROKES — 재생 애니메이션 지원) -->
        <g
          v-else-if="layer.visible && layer.kind === 'STROKES'"
          class="svg-layer layer-strokes"
          :data-color="layer.label_color"
          :opacity="layer.opacity"
        >
          <path
            v-for="(stroke, sIdx) in visibleStrokesOfWork(layer.strokes)"
            :key="`work-fill-${stroke.stroke_order}`"
            class="ink-stroke"
            vector-effect="non-scaling-stroke"
            :class="{
              'radical-stroke': stroke.is_radical,
              'is-picked': editableLayer?.id === layer.id && selectedIndex === sIdx,
            }"
            :d="stroke.outline_path"
            @pointerdown="onShapePointerDown(layer.id, sIdx, $event)"
          />
          <clipPath
            v-for="stroke in visibleStrokesOfWork(layer.strokes)"
            :id="`clip-${stroke.stroke_order}`"
            :key="`clip-${stroke.stroke_order}`"
          >
            <path :d="stroke.outline_path" />
          </clipPath>
          <polyline
            v-for="(stroke, index) in visibleStrokesOfWork(layer.strokes)"
            :key="`work-anim-${stroke.stroke_order}`"
            :clip-path="`url(#clip-${stroke.stroke_order})`"
            class="anim-stroke"
            :class="{ radical: stroke.is_radical }"
            :points="polylinePoints(stroke.median_points)"
            :stroke-width="stroke.stroke_width"
            :stroke-dasharray="strokeDash(stroke, index, shown, reveal).array"
            :stroke-dashoffset="strokeDash(stroke, index, shown, reveal).offset"
          />
        </g>

        <!-- 4. 중심선 오버레이 레이어 (MEDIANS) — 편집 대상 레이어의 중심선 -->
        <g
          v-else-if="layer.visible && layer.kind === 'MEDIANS'"
          class="svg-layer layer-medians"
          :opacity="layer.opacity"
          :data-color="editableLayer?.label_color ?? 'amber'"
        >
          <polyline
            v-for="(stroke, sIdx) in overlayStrokes"
            :key="`ov-median-${sIdx}`"
            class="median-stroke"
            :class="{ 'is-current-median': sIdx === selectedIndex }"
            :points="polylinePoints(stroke.median_points)"
          />
        </g>

        <!-- 5. 획순 번호 오버레이 레이어 (NUMBERS) — 편집 대상 레이어의 획순 -->
        <g
          v-else-if="layer.visible && layer.kind === 'NUMBERS'"
          class="svg-layer layer-numbers"
          :opacity="layer.opacity"
          :data-color="editableLayer?.label_color ?? 'rose'"
        >
          <g
            v-for="(stroke, index) in overlayStrokes"
            :key="`ov-num-${index}`"
            :transform="`translate(${stroke.median_points[0][0]} ${stroke.median_points[0][1]}) scale(1 -1)`"
          >
            <circle :r="BADGE_RADIUS" class="num-badge" />
            <text text-anchor="middle" dominant-baseline="central">{{ index + 1 }}</text>
          </g>
        </g>
      </template>

      <!-- ==== 도구별 편집 인터랙션 오버레이 (잠금 해제 시 활성화) ==== -->

      <!-- A. 선택·변환(select) 바운딩 박스 및 변형 방식별 핸들 -->
      <TransformOverlay
        v-if="tool === 'select' && activeBBox && !locked && editableLayer?.kind !== 'FONT'"
        :bbox="activeBBox"
        :handles="resizeHandles"
        :transform-mode="transformMode"
        @start-move="startMoveDrag"
        @start-handle="startHandleDrag"
      />

      <!-- B. 베지어 정점 직접 편집(bezier) 핸들 -->
      <BezierOverlay
        v-if="tool === 'bezier' && !locked && targetBezierPath"
        :nodes="bezierNodes"
        @start-drag="startBezierHandleDrag"
      />

      <!-- C. 중심선 정점 편집(median) 핸들 -->
      <MedianEditOverlay
        v-if="tool === 'median' && !locked && targetMedianPoints.length > 0"
        :points="targetMedianPoints"
        @line-pointer-down="onMedianLinePointerDown"
        @vertex-pointer-down="onMedianVertexPointerDown"
        @delete-vertex="emit('deleteMedianVertex', selectedIndex, $event)"
      />

      <!-- D. 칼 분할(knife) 점·꺾인 선 표시 -->
      <KnifeOverlay v-if="knifePoints.length > 0" :knife-points="knifePoints" />

      <!-- E. 윤곽 연결(connect) 점·미리보기 -->
      <ConnectOverlay v-if="tool === 'connect' && connectPoints.length > 0" :connect-points="connectPoints" />
    </g>

    <rect
      v-if="marquee"
      class="zoom-marquee"
      :x="Math.min(marquee.x0, marquee.x1)"
      :y="Math.min(marquee.y0, marquee.y1)"
      :width="Math.abs(marquee.x1 - marquee.x0)"
      :height="Math.abs(marquee.y1 - marquee.y0)"
    />
    <LoupeOverlay v-if="loupeVisible && loupeLens && loupeEnabled && !zoomed && !zoomArmed" :lens="loupeLens" :zoom="loupeZoom" :radius="LOUPE_RADIUS" />
  </svg>
  <div class="canvas-zoom-bar">
    <button
      type="button"
      class="bar-btn"
      :class="{ on: zoomArmed }"
      :aria-pressed="zoomArmed"
      title="확대할 영역을 드래그합니다. 놓은 뒤 그 배율에서 점을 그대로 편집합니다. 휠로도 배율을 바꿉니다."
      @click="toggleZoomArm"
    >
      영역 확대
    </button>
    <button
      v-if="zoomed"
      type="button"
      class="bar-btn"
      title="글자 전체로 돌아갑니다. 가운데 버튼으로 화면을 옮길 수 있습니다."
      @click="resetView"
    >
      전체
    </button>
    <span v-if="zoomArmed" class="zoom-hint">확대할 영역을 드래그하세요</span>
  </div>
  </div>
  <div v-else class="empty-state">
    <svg class="empty-svg-icon" viewBox="0 0 36 36" fill="none" aria-hidden="true">
      <rect x="4" y="4" width="28" height="28" rx="4" stroke="currentColor" stroke-width="1.6" />
      <path d="M18 4v28M4 18h28" stroke="currentColor" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.5" />
      <path d="M12 14h12M18 11v14" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
    </svg>
    <h3>선택된 한자가 없습니다</h3>
    <p>좌측 목록에서 편집할 한자를 선택하거나 검색하세요.</p>
  </div>
</template>
