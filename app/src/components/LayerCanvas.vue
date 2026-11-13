<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { BADGE_RADIUS, CANVAS } from '../lib/constants.ts'
import {
  moveEditableHandle,
  parseEditablePath,
  pathsBBox,
  serializeEditablePath,
  strokesBBox,
  type BBox,
  type EditableSeg,
  type HandleRef,
} from '../lib/vectorEdit.ts'
import type { CharacterDetail, EditorTool, LayerRecord, Pt, StrokeRecord } from '../types.ts'

type ResizeDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

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
const loupeVisible = ref(false)
const loupeFont = ref<Pt | null>(null)
const LOUPE_ZOOM = 2.8
const LOUPE_RADIUS = 58
const LOUPE_OFFSET = 78

const loupeEnabled = computed(
  () => props.tool === 'bezier' || props.tool === 'median' || props.tool === 'knife' || props.tool === 'connect',
)

/** 글자 윤곽이 0~CANVAS를 벗어날 때 균등 축소·중앙 정렬해 캔버스 안에 넣는다. */
const FIT_PAD = CANVAS * 0.05

const contentBBox = computed<BBox | null>(() => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const absorb = (b: BBox | null) => {
    if (!b) return
    if (b.minX < minX) minX = b.minX
    if (b.minY < minY) minY = b.minY
    if (b.maxX > maxX) maxX = b.maxX
    if (b.maxY > maxY) maxY = b.maxY
  }
  for (const layer of props.orderedLayers) {
    if (!layer.visible) continue
    if (layer.kind === 'MEDIANS' || layer.kind === 'NUMBERS') continue
    if (layer.strokes.length > 0) {
      const list = layer.kind === 'STROKES' ? visibleStrokesOfWork(layer.strokes) : layer.strokes
      absorb(strokesBBox(list))
    } else if (layer.paths.length > 0) {
      absorb(pathsBBox(layer.paths))
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
})

const contentFit = computed(() => {
  const b = contentBBox.value
  if (!b) return { scale: 1, ox: 0, oy: 0 }
  const overflows = b.minX < 0 || b.minY < 0 || b.maxX > CANVAS || b.maxY > CANVAS
  if (!overflows) return { scale: 1, ox: 0, oy: 0 }
  const bw = Math.max(1, b.maxX - b.minX)
  const bh = Math.max(1, b.maxY - b.minY)
  const inner = CANVAS - 2 * FIT_PAD
  // 넘칠 때만 축소·중앙 정렬한다. 이미 들어가는 글자는 키우지 않는다.
  const scale = Math.min(inner / bw, inner / bh, 1)
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  return {
    scale,
    ox: CANVAS / 2 - cx * scale,
    oy: CANVAS / 2 - cy * scale,
  }
})

const worldTransform = computed(() => {
  const { scale, ox, oy } = contentFit.value
  if (scale === 1 && ox === 0 && oy === 0) return `translate(0 ${CANVAS}) scale(1 -1)`
  return `translate(0 ${CANVAS}) scale(1 -1) translate(${ox} ${oy}) scale(${scale})`
})

function fontToScreen(pt: Pt): { x: number; y: number } {
  const { scale, ox, oy } = contentFit.value
  const fx = ox + pt[0] * scale
  const fy = oy + pt[1] * scale
  return { x: fx, y: CANVAS - fy }
}

const loupeScreen = computed(() => {
  const pt = loupeFont.value
  if (!pt) return null
  return fontToScreen(pt)
})

const loupeLens = computed(() => {
  const s = loupeScreen.value
  if (!s) return null
  // 커서를 가리지 않도록 우상단으로 오프셋
  const cx = Math.min(CANVAS - LOUPE_RADIUS - 4, Math.max(LOUPE_RADIUS + 4, s.x + LOUPE_OFFSET * 0.55))
  const cy = Math.min(CANVAS - LOUPE_RADIUS - 4, Math.max(LOUPE_RADIUS + 4, s.y - LOUPE_OFFSET * 0.75))
  return { cx, cy, sx: s.x, sy: s.y }
})

function eventToFont(event: PointerEvent | MouseEvent): Pt | null {
  const ctm = worldGroup.value?.getScreenCTM()
  if (!ctm) return null
  const pt = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse())
  return [pt.x, pt.y]
}

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
  return strokes.slice(0, Math.max(0, Math.min(strokes.length, props.shown)))
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

// ---- 포인터 드래그 세션 관리 (누적 반올림 오차 방지용 스냅샷 기반) ----
let cleanupDrag: (() => void) | null = null

function stopActiveDrag() {
  cleanupDrag?.()
  cleanupDrag = null
}

onBeforeUnmount(stopActiveDrag)

function cloneStrokes(list: StrokeRecord[]): StrokeRecord[] {
  return list.map((s) => ({ ...s, median_points: s.median_points.map((p): Pt => [p[0], p[1]]) }))
}

function onCanvasPointerMove(event: PointerEvent) {
  if (!loupeEnabled.value) {
    loupeVisible.value = false
    return
  }
  const pt = eventToFont(event)
  if (!pt) {
    loupeVisible.value = false
    return
  }
  loupeFont.value = pt
  loupeVisible.value = true
}

function onCanvasPointerLeave() {
  loupeVisible.value = false
}

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

function startMoveDrag(event: PointerEvent) {
  const ed = props.editableLayer
  const startPt = eventToFont(event)
  if (!ed || !startPt || props.locked) return
  stopActiveDrag()
  const snapStrokes = cloneStrokes(ed.strokes)
  const snapPaths = ed.paths.slice()

  const onMove = (moveEvent: PointerEvent) => {
    const cur = eventToFont(moveEvent)
    if (!cur) return
    const dx = cur[0] - startPt[0]
    const dy = cur[1] - startPt[1]
    emit('restoreSnapshot', cloneStrokes(snapStrokes), snapPaths.slice())
    emit('transformBy', (x, y) => [x + dx, y + dy], 1)
  }
  const onUp = () => stopActiveDrag()
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp, { once: true })
  cleanupDrag = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
}

function startResizeDrag(dir: ResizeDir, event: PointerEvent) {
  event.stopPropagation()
  const ed = props.editableLayer
  const box = activeBBox.value
  const startPt = eventToFont(event)
  if (!ed || !box || !startPt || props.locked) return
  stopActiveDrag()

  const snapStrokes = cloneStrokes(ed.strokes)
  const snapPaths = ed.paths.slice()
  const initBox = { ...box }
  const w0 = Math.max(4, initBox.maxX - initBox.minX)
  const h0 = Math.max(4, initBox.maxY - initBox.minY)

  const anchorX = dir.includes('w') ? initBox.maxX : dir.includes('e') ? initBox.minX : (initBox.minX + initBox.maxX) / 2
  const anchorY = dir.includes('s') ? initBox.maxY : dir.includes('n') ? initBox.minY : (initBox.minY + initBox.maxY) / 2

  const onMove = (moveEvent: PointerEvent) => {
    const cur = eventToFont(moveEvent)
    if (!cur) return
    let sx = 1
    let sy = 1
    if (dir.includes('e')) sx = Math.max(0.1, (cur[0] - anchorX) / w0)
    else if (dir.includes('w')) sx = Math.max(0.1, (anchorX - cur[0]) / w0)

    if (dir.includes('n')) sy = Math.max(0.1, (cur[1] - anchorY) / h0)
    else if (dir.includes('s')) sy = Math.max(0.1, (anchorY - cur[1]) / h0)

    if (moveEvent.shiftKey) {
      const uni = dir === 'n' || dir === 's' ? sy : dir === 'e' || dir === 'w' ? sx : (sx + sy) / 2
      sx = uni
      sy = uni
    }

    emit('restoreSnapshot', cloneStrokes(snapStrokes), snapPaths.slice())
    emit(
      'transformBy',
      (x, y) => [anchorX + (x - anchorX) * sx, anchorY + (y - anchorY) * sy],
      (sx + sy) / 2,
    )
  }
  const onUp = () => stopActiveDrag()
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp, { once: true })
  cleanupDrag = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
}

function startBezierHandleDrag(handle: HandleRef, event: PointerEvent) {
  event.stopPropagation()
  const d = targetBezierPath.value
  if (!d || props.locked) return
  stopActiveDrag()
  const initialSegs: EditableSeg[] = parseEditablePath(d)
  const targetIdx = props.selectedIndex

  const onMove = (moveEvent: PointerEvent) => {
    const cur = eventToFont(moveEvent)
    if (!cur) return
    const updated = moveEditableHandle(initialSegs, handle, cur)
    emit('updatePath', targetIdx, serializeEditablePath(updated))
  }
  const onUp = () => stopActiveDrag()
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp, { once: true })
  cleanupDrag = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
}

function onMedianVertexPointerDown(ptIdx: number, event: PointerEvent) {
  event.stopPropagation()
  if (props.locked) return
  if (event.altKey) {
    emit('deleteMedianVertex', props.selectedIndex, ptIdx)
    return
  }
  stopActiveDrag()
  const strokeIdx = props.selectedIndex
  const onMove = (moveEvent: PointerEvent) => {
    const cur = eventToFont(moveEvent)
    if (!cur) return
    emit('moveMedianVertex', strokeIdx, ptIdx, cur)
  }
  const onUp = () => stopActiveDrag()
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp, { once: true })
  cleanupDrag = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
}

function onMedianLinePointerDown(event: PointerEvent) {
  event.stopPropagation()
  if (props.locked) return
  const pt = eventToFont(event)
  if (pt) emit('addMedianVertex', props.selectedIndex, pt)
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
