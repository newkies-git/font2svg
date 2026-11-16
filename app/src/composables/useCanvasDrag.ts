import { onBeforeUnmount } from 'vue'
import {
  moveEditableHandle,
  parseEditablePath,
  serializeEditablePath,
  type BBox,
  type EditableSeg,
  type HandleRef,
} from '../lib/vectorEdit.ts'
import { distortMap, MIN_BOX_SIDE, rotateMap, skewMap, type HandleDir, type TransformMode } from '../lib/transformMath.ts'
import type { LayerRecord, Pt, StrokeRecord } from '../types.ts'

export type ResizeDir = HandleDir

// 크기 조절 시 뒤집힘을 막는 최소 배율
const MIN_SCALE = 0.1

type DragEmit = {
  restoreSnapshot: (strokes: StrokeRecord[], paths: string[]) => void
  transformBy: (fn: (x: number, y: number) => Pt, scaleFactor: number) => void
  updatePath: (index: number, path: string) => void
  moveMedianVertex: (strokeIdx: number, ptIdx: number, to: Pt) => void
  addMedianVertex: (strokeIdx: number, at: Pt) => void
  deleteMedianVertex: (strokeIdx: number, ptIdx: number) => void
}

function cloneStrokes(list: StrokeRecord[]): StrokeRecord[] {
  return list.map((s) => ({ ...s, median_points: s.median_points.map((p): Pt => [p[0], p[1]]) }))
}

export function useCanvasDrag(options: {
  editableLayer: () => LayerRecord | null
  locked: () => boolean
  selectedIndex: () => number
  activeBBox: () => BBox | null
  transformMode: () => TransformMode
  targetBezierPath: () => string | null
  eventToFont: (event: PointerEvent | MouseEvent) => Pt | null
  emit: DragEmit
}) {
  const { editableLayer, locked, selectedIndex, activeBBox, transformMode, targetBezierPath, eventToFont, emit } = options

  let cleanupDrag: (() => void) | null = null

  function stopActiveDrag() {
    cleanupDrag?.()
    cleanupDrag = null
  }

  onBeforeUnmount(stopActiveDrag)

  function startMoveDrag(event: PointerEvent) {
    const ed = editableLayer()
    const startPt = eventToFont(event)
    if (!ed || !startPt || locked()) return
    stopActiveDrag()
    const snapStrokes = cloneStrokes(ed.strokes)
    const snapPaths = ed.paths.slice()

    const onMove = (moveEvent: PointerEvent) => {
      const cur = eventToFont(moveEvent)
      if (!cur) return
      const dx = cur[0] - startPt[0]
      const dy = cur[1] - startPt[1]
      emit.restoreSnapshot(cloneStrokes(snapStrokes), snapPaths.slice())
      emit.transformBy((x, y) => [x + dx, y + dy], 1)
    }
    const onUp = () => stopActiveDrag()
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    cleanupDrag = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }

  // 핸들 드래그: 변형 방식(크기/회전/기울임/왜곡)에 따라 점 변환 함수를 만들어 스냅샷에 적용한다.
  function startHandleDrag(dir: ResizeDir, event: PointerEvent) {
    event.stopPropagation()
    const ed = editableLayer()
    const box = activeBBox()
    const startPt = eventToFont(event)
    if (!ed || !box || !startPt || locked()) return
    stopActiveDrag()

    const snapStrokes = cloneStrokes(ed.strokes)
    const snapPaths = ed.paths.slice()
    const initBox = { ...box }
    const mode = transformMode()
    const center: Pt = [(initBox.minX + initBox.maxX) / 2, (initBox.minY + initBox.maxY) / 2]
    const w0 = Math.max(MIN_BOX_SIDE, initBox.maxX - initBox.minX)
    const h0 = Math.max(MIN_BOX_SIDE, initBox.maxY - initBox.minY)

    const anchorX = dir.includes('w') ? initBox.maxX : dir.includes('e') ? initBox.minX : center[0]
    const anchorY = dir.includes('s') ? initBox.maxY : dir.includes('n') ? initBox.minY : center[1]

    function buildTransform(cur: Pt, shiftKey: boolean): { fn: (x: number, y: number) => Pt; scaleFactor: number } {
      if (mode === 'rotate') return { fn: rotateMap(center, startPt as Pt, cur, shiftKey), scaleFactor: 1 }
      if (mode === 'skew') return { fn: skewMap(initBox, dir, startPt as Pt, cur), scaleFactor: 1 }
      if (mode === 'distort') {
        const { map, areaRatio } = distortMap(initBox, dir, startPt as Pt, cur)
        return { fn: map, scaleFactor: Math.sqrt(areaRatio) }
      }
      let sx = 1
      let sy = 1
      if (dir.includes('e')) sx = Math.max(MIN_SCALE, (cur[0] - anchorX) / w0)
      else if (dir.includes('w')) sx = Math.max(MIN_SCALE, (anchorX - cur[0]) / w0)

      if (dir.includes('n')) sy = Math.max(MIN_SCALE, (cur[1] - anchorY) / h0)
      else if (dir.includes('s')) sy = Math.max(MIN_SCALE, (anchorY - cur[1]) / h0)

      if (shiftKey) {
        const uni = dir === 'n' || dir === 's' ? sy : dir === 'e' || dir === 'w' ? sx : (sx + sy) / 2
        sx = uni
        sy = uni
      }
      return {
        fn: (x, y): Pt => [anchorX + (x - anchorX) * sx, anchorY + (y - anchorY) * sy],
        scaleFactor: (sx + sy) / 2,
      }
    }

    const onMove = (moveEvent: PointerEvent) => {
      const cur = eventToFont(moveEvent)
      if (!cur) return
      const { fn, scaleFactor } = buildTransform(cur, moveEvent.shiftKey)
      emit.restoreSnapshot(cloneStrokes(snapStrokes), snapPaths.slice())
      emit.transformBy(fn, scaleFactor)
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
    const d = targetBezierPath()
    if (!d || locked()) return
    stopActiveDrag()
    const initialSegs: EditableSeg[] = parseEditablePath(d)
    const targetIdx = selectedIndex()

    const onMove = (moveEvent: PointerEvent) => {
      const cur = eventToFont(moveEvent)
      if (!cur) return
      const updated = moveEditableHandle(initialSegs, handle, cur)
      emit.updatePath(targetIdx, serializeEditablePath(updated))
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
    if (locked()) return
    if (event.altKey) {
      emit.deleteMedianVertex(selectedIndex(), ptIdx)
      return
    }
    stopActiveDrag()
    const strokeIdx = selectedIndex()
    const onMove = (moveEvent: PointerEvent) => {
      const cur = eventToFont(moveEvent)
      if (!cur) return
      emit.moveMedianVertex(strokeIdx, ptIdx, cur)
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
    if (locked()) return
    const pt = eventToFont(event)
    if (pt) emit.addMedianVertex(selectedIndex(), pt)
  }

  return {
    startMoveDrag,
    startHandleDrag,
    startBezierHandleDrag,
    onMedianVertexPointerDown,
    onMedianLinePointerDown,
  }
}
