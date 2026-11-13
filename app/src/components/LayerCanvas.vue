<script setup lang="ts">
import { computed, ref } from 'vue'
import { useCanvasDrag, type ResizeDir } from '../composables/useCanvasDrag.ts'
import { useCanvasFit, visibleWorkStrokes } from '../composables/useCanvasFit.ts'
import { useCanvasLoupe } from '../composables/useCanvasLoupe.ts'
import { BADGE_RADIUS, CANVAS } from '../lib/constants.ts'
import { parseEditablePath, pathsBBox, strokesBBox, type BBox } from '../lib/vectorEdit.ts'
import type { CharacterDetail, EditorTool, LayerRecord, Pt, StrokeRecord } from '../types.ts'

const props = defineProps<{
  selected: CharacterDetail | null
  orderedLayers: LayerRecord[]
  editableLayer: LayerRecord | null
  locked: boolean
  tool: EditorTool
  scope: 'layer' | 'stroke'
  selectedIndex: number
  shown: number
  reveal: number
  knifeFrom: Pt | null
  connectPoints: Pt[]
}>()

const emit = defineEmits<{
  selectItem: [index: number]
  knifePoint: [point: Pt]
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
  LOUPE_ZOOM,
  LOUPE_RADIUS,
  onCanvasPointerMove,
  onCanvasPointerLeave,
} = useCanvasLoupe(() => props.tool, fontToScreen, eventToFont)

function lengthOf(points: Pt[]): number {
  let length = 0
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  }
  return length
}

function dashOf(stroke: StrokeRecord, index: number) {
  const length = lengthOf(stroke.median_points)
  const span = length + stroke.stroke_width
  const amount = index < props.shown - 1 ? 0 : index === props.shown - 1 ? span * (1 - props.reveal) : span
  return { array: span, offset: amount }
}

function pointsOf(points: Pt[]): string {
  return points.map((p) => p.join(',')).join(' ')
}

function visibleStrokesOfWork(strokes: StrokeRecord[]): StrokeRecord[] {
  return visibleWorkStrokes(strokes, props.shown)
}

// 작업 획(STROKES) 레이어의 표시 대상 획 목록
const workStrokes = computed<StrokeRecord[]>(() => {
  const work = props.orderedLayers.find((l) => l.id === 'strokes')
  return work ? visibleStrokesOfWork(work.strokes) : []
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
  if (ed.kind === 'FONT' && ed.strokes.length === 0) {
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

const resizeHandles = computed<{ dir: ResizeDir; x: number; y: number }[]>(() => {
  const b = activeBBox.value
  if (!b) return []
  const mx = (b.minX + b.maxX) / 2
  const my = (b.minY + b.maxY) / 2
  // y축이 위쪽이므로 maxY가 화면 위쪽(north), minY가 화면 아래쪽(south)
  return [
    { dir: 'nw', x: b.minX, y: b.maxY },
    { dir: 'n', x: mx, y: b.maxY },
    { dir: 'ne', x: b.maxX, y: b.maxY },
    { dir: 'e', x: b.maxX, y: my },
    { dir: 'se', x: b.maxX, y: b.minY },
    { dir: 's', x: mx, y: b.minY },
    { dir: 'sw', x: b.minX, y: b.minY },
    { dir: 'w', x: b.minX, y: my },
  ]
})

// 베지어 편집용 파싱 결과
const targetBezierPath = computed<string | null>(() => {
  const ed = props.editableLayer
  if (!ed || props.tool !== 'bezier') return null
  if (ed.kind === 'FONT' && ed.strokes.length === 0) {
    return ed.paths[props.selectedIndex] ?? null
  }
  return ed.strokes[props.selectedIndex]?.outline_path ?? null
})

const bezierNodes = computed(() => {
  const d = targetBezierPath.value
  if (!d) return { anchors: [], controls: [], lines: [] }
  const segs = parseEditablePath(d)
  const anchors: { segIndex: number; x: number; y: number }[] = []
  const controls: { kind: 'c1' | 'c2'; segIndex: number; x: number; y: number }[] = []
  const lines: { x1: number; y1: number; x2: number; y2: number }[] = []

  let prevX = 0
  let prevY = 0
  let startX = 0
  let startY = 0

  segs.forEach((seg, idx) => {
    if (seg.op === 'M') {
      anchors.push({ segIndex: idx, x: seg.x, y: seg.y })
      prevX = seg.x
      prevY = seg.y
      startX = seg.x
      startY = seg.y
    } else if (seg.op === 'L') {
      anchors.push({ segIndex: idx, x: seg.x, y: seg.y })
      prevX = seg.x
      prevY = seg.y
    } else if (seg.op === 'Q') {
      lines.push({ x1: prevX, y1: prevY, x2: seg.x1, y2: seg.y1 })
      lines.push({ x1: seg.x, y1: seg.y, x2: seg.x1, y2: seg.y1 })
      controls.push({ kind: 'c1', segIndex: idx, x: seg.x1, y: seg.y1 })
      anchors.push({ segIndex: idx, x: seg.x, y: seg.y })
      prevX = seg.x
      prevY = seg.y
    } else if (seg.op === 'C') {
      lines.push({ x1: prevX, y1: prevY, x2: seg.x1, y2: seg.y1 })
      lines.push({ x1: seg.x, y1: seg.y, x2: seg.x2, y2: seg.y2 })
      controls.push({ kind: 'c1', segIndex: idx, x: seg.x1, y: seg.y1 })
      controls.push({ kind: 'c2', segIndex: idx, x: seg.x2, y: seg.y2 })
      anchors.push({ segIndex: idx, x: seg.x, y: seg.y })
      prevX = seg.x
      prevY = seg.y
    } else if (seg.op === 'Z') {
      prevX = startX
      prevY = startY
    }
  })

  return { anchors, controls, lines }
})

const targetMedianPoints = computed<Pt[]>(() => {
  const ed = props.editableLayer
  if (!ed || props.tool !== 'median') return []
  return ed.strokes[props.selectedIndex]?.median_points ?? []
})

const {
  startMoveDrag,
  startResizeDrag,
  startBezierHandleDrag,
  onMedianVertexPointerDown,
  onMedianLinePointerDown,
} = useCanvasDrag({
  editableLayer: () => props.editableLayer,
  locked: () => props.locked,
  selectedIndex: () => props.selectedIndex,
  activeBBox: () => activeBBox.value,
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
    emit('knifePoint', pt)
    return
  }
  if (props.tool === 'connect' && !props.locked) {
    emit('connectPoint', pt)
  }
}

function onCanvasDblClick(event: MouseEvent) {
  if (props.tool !== 'connect' || props.locked) return
  event.preventDefault()
  if (props.connectPoints.length >= 3) emit('commitConnect')
}

function onShapePointerDown(layerId: string, index: number, event: PointerEvent) {
  if (event.button !== 0) return
  if (props.tool === 'knife' || props.tool === 'connect') return // 칼·연결 도구는 상위 SVG 클릭으로 전달
  if (props.editableLayer?.id !== layerId) return
  event.stopPropagation()
  emit('selectItem', index)
  if (props.tool === 'select' && !props.locked) {
    startMoveDrag(event)
  }
}

function connectLabel(idx: number, total: number): string {
  if (idx === 0) return '시'
  if (idx === total - 1 && total > 1) return '끝'
  return String(idx)
}
</script>

<template>
  <svg
    v-if="selected"
    role="img"
    class="layer-canvas-svg"
    :data-tool="tool"
    :aria-label="`${selected.char} (${selected.reading ?? ''}) 레이어 필순 편집기`"
    :viewBox="`0 0 ${CANVAS} ${CANVAS}`"
    tabindex="0"
    @pointerdown="onCanvasPointerDown"
    @pointermove="onCanvasPointerMove"
    @pointerleave="onCanvasPointerLeave"
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
            :class="{ 'is-picked': editableLayer?.id === layer.id && selectedIndex === pIdx }"
            :d="d"
            @pointerdown="onShapePointerDown(layer.id, pIdx, $event)"
          />
          <path
            v-for="(stroke, sIdx) in layer.strokes"
            :key="`font-s-${sIdx}`"
            class="font-contour"
            :class="{ 'is-picked': editableLayer?.id === layer.id && selectedIndex === sIdx }"
            :d="stroke.outline_path"
            @pointerdown="onShapePointerDown(layer.id, sIdx, $event)"
          />
        </g>

        <!-- 2. 레퍼런스 및 커스텀 레이어 (MMH / ACJK / NAVER / CUSTOM) -->
        <g
          v-else-if="layer.visible && (layer.kind === 'MMH' || layer.kind === 'ACJK' || layer.kind === 'NAVER' || layer.kind === 'CUSTOM')"
          class="svg-layer layer-ref"
          :data-color="layer.label_color"
          :opacity="layer.opacity"
        >
          <path
            v-for="(d, pIdx) in layer.paths"
            :key="`${layer.id}-p-${pIdx}`"
            class="ref-outline"
            :class="{ 'is-picked': editableLayer?.id === layer.id && selectedIndex === pIdx }"
            :d="d"
            @pointerdown="onShapePointerDown(layer.id, pIdx, $event)"
          />
          <path
            v-for="(stroke, sIdx) in layer.strokes"
            :key="`${layer.id}-s-${sIdx}`"
            class="ref-outline"
            :class="{
              'is-picked': editableLayer?.id === layer.id && selectedIndex === sIdx,
              'is-radical': stroke.is_radical,
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
            :points="pointsOf(stroke.median_points)"
            :stroke-width="stroke.stroke_width"
            :stroke-dasharray="dashOf(stroke, index).array"
            :stroke-dashoffset="dashOf(stroke, index).offset"
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
            :points="pointsOf(stroke.median_points)"
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

      <!-- A. 선택·변환(select) 바운딩 박스 및 8방향 크기 조절 핸들 -->
      <g v-if="tool === 'select' && activeBBox && !locked" class="overlay-transform">
        <rect
          :x="activeBBox.minX"
          :y="activeBBox.minY"
          :width="Math.max(1, activeBBox.maxX - activeBBox.minX)"
          :height="Math.max(1, activeBBox.maxY - activeBBox.minY)"
          class="bbox-move-zone"
          @pointerdown.stop="startMoveDrag"
        />
        <rect
          v-for="h in resizeHandles"
          :key="h.dir"
          :x="h.x - 10"
          :y="h.y - 10"
          width="20"
          height="20"
          class="bbox-handle"
          :data-dir="h.dir"
          @pointerdown="startResizeDrag(h.dir, $event)"
        />
      </g>

      <!-- B. 베지어 정점 직접 편집(bezier) 핸들 -->
      <g v-if="tool === 'bezier' && !locked && targetBezierPath" class="overlay-bezier">
        <line
          v-for="(ln, lIdx) in bezierNodes.lines"
          :key="`bl-${lIdx}`"
          :x1="ln.x1"
          :y1="ln.y1"
          :x2="ln.x2"
          :y2="ln.y2"
          class="bezier-arm"
        />
        <circle
          v-for="(ctrl, cIdx) in bezierNodes.controls"
          :key="`bc-${cIdx}`"
          :cx="ctrl.x"
          :cy="ctrl.y"
          r="9"
          class="bezier-ctrl-pt"
          @pointerdown="startBezierHandleDrag({ kind: ctrl.kind, segIndex: ctrl.segIndex }, $event)"
        />
        <rect
          v-for="(anc, aIdx) in bezierNodes.anchors"
          :key="`ba-${aIdx}`"
          :x="anc.x - 8"
          :y="anc.y - 8"
          width="16"
          height="16"
          class="bezier-anchor-pt"
          @pointerdown="startBezierHandleDrag({ kind: 'anchor', segIndex: anc.segIndex }, $event)"
        />
      </g>

      <!-- C. 중심선 정점 편집(median) 핸들 -->
      <g v-if="tool === 'median' && !locked && targetMedianPoints.length > 0" class="overlay-median-edit">
        <polyline
          :points="pointsOf(targetMedianPoints)"
          class="median-hit-line"
          @pointerdown="onMedianLinePointerDown"
        />
        <polyline
          :points="pointsOf(targetMedianPoints)"
          class="median-active-guide"
        />
        <g
          v-for="(pt, ptIdx) in targetMedianPoints"
          :key="`mv-${ptIdx}`"
          :transform="`translate(${pt[0]} ${pt[1]})`"
          @pointerdown="onMedianVertexPointerDown(ptIdx, $event)"
          @contextmenu.prevent="emit('deleteMedianVertex', selectedIndex, ptIdx)"
        >
          <circle
            :r="ptIdx === 0 || ptIdx === targetMedianPoints.length - 1 ? 14 : 11"
            class="median-vertex"
            :class="{
              'is-start': ptIdx === 0,
              'is-end': ptIdx === targetMedianPoints.length - 1 && ptIdx > 0,
            }"
          />
          <text
            v-if="ptIdx === 0 || ptIdx === targetMedianPoints.length - 1"
            transform="scale(1 -1)"
            class="median-vertex-label"
            text-anchor="middle"
            dominant-baseline="central"
          >
            {{ ptIdx === 0 ? '기' : '수' }}
          </text>
        </g>
      </g>

      <!-- D. 칼 분할(knife) 시작점 표시 -->
      <g v-if="knifeFrom" :transform="`translate(${knifeFrom[0]} ${knifeFrom[1]})`">
        <circle r="14" class="knife-point-pulse" />
        <circle r="5" class="knife-point" />
      </g>

      <!-- E. 윤곽 연결(connect) 점·미리보기 -->
      <g v-if="tool === 'connect' && connectPoints.length > 0" class="overlay-connect">
        <polyline
          v-if="connectPoints.length > 1"
          :points="pointsOf(connectPoints)"
          class="connect-guide"
        />
        <line
          v-if="connectPoints.length >= 3"
          class="connect-close-hint"
          :x1="connectPoints[connectPoints.length - 1][0]"
          :y1="connectPoints[connectPoints.length - 1][1]"
          :x2="connectPoints[0][0]"
          :y2="connectPoints[0][1]"
        />
        <g
          v-for="(pt, ptIdx) in connectPoints"
          :key="`cp-${ptIdx}`"
          :transform="`translate(${pt[0]} ${pt[1]})`"
        >
          <circle
            :r="ptIdx === 0 || ptIdx === connectPoints.length - 1 ? 13 : 10"
            class="connect-vertex"
            :class="{
              'is-start': ptIdx === 0,
              'is-end': ptIdx === connectPoints.length - 1 && ptIdx > 0,
            }"
          />
          <text transform="scale(1 -1)" class="connect-vertex-label" text-anchor="middle" dominant-baseline="central">
            {{ connectLabel(ptIdx, connectPoints.length) }}
          </text>
        </g>
      </g>
    </g>

    <!-- 돋보기: 정밀 도구(베지어·중심선·칼·윤곽연결)에서 커서 주변을 확대 -->
    <g
      v-if="loupeVisible && loupeLens && loupeEnabled"
      class="overlay-loupe"
      aria-hidden="true"
      style="pointer-events: none"
    >
      <circle :cx="loupeLens.cx" :cy="loupeLens.cy" :r="LOUPE_RADIUS" class="loupe-backdrop" />
      <g clip-path="url(#loupe-clip)">
        <g
          :transform="`translate(${loupeLens.cx} ${loupeLens.cy}) scale(${LOUPE_ZOOM}) translate(${-loupeLens.sx} ${-loupeLens.sy})`"
        >
          <use href="#canvas-world" />
        </g>
      </g>
      <circle :cx="loupeLens.cx" :cy="loupeLens.cy" :r="LOUPE_RADIUS" class="loupe-ring" />
      <line
        :x1="loupeLens.cx - 10"
        :y1="loupeLens.cy"
        :x2="loupeLens.cx + 10"
        :y2="loupeLens.cy"
        class="loupe-cross"
      />
      <line
        :x1="loupeLens.cx"
        :y1="loupeLens.cy - 10"
        :x2="loupeLens.cx"
        :y2="loupeLens.cy + 10"
        class="loupe-cross"
      />
      <line
        class="loupe-leader"
        :x1="loupeLens.sx"
        :y1="loupeLens.sy"
        :x2="loupeLens.cx"
        :y2="loupeLens.cy"
      />
      <circle :cx="loupeLens.sx" :cy="loupeLens.sy" r="3" class="loupe-focus" />
    </g>
  </svg>
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
