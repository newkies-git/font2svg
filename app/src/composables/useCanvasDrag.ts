import { onBeforeUnmount } from 'vue'
import { anchorIndicesInBox, moveEditableAnchors } from '../lib/pathPointEdit.ts'
import {
  moveEditableHandle,
  parseEditablePath,
  serializeEditablePath,
  type BBox,
  type EditableSeg,
  type HandleRef,
} from '../../shared/vectorEdit.ts'
import { dragTransform, type HandleDir, type TransformMode } from '../lib/transformMath.ts'
import type { LayerRecord, Pt, StrokeRecord } from '../../shared/types.ts'
import { cloneStroke } from './layerClone.ts'

const cloneStrokesOf = (list: StrokeRecord[]): StrokeRecord[] => list.map(cloneStroke)
const MARQUEE_MIN_DRAG = 4

export type ResizeDir = HandleDir
export type PointMarquee = { x0: number; y0: number; x1: number; y1: number }

type DragEmit = {
  restoreSnapshot: (strokes: StrokeRecord[], paths: string[]) => void
  transformBy: (fn: (x: number, y: number) => Pt, scaleFactor: number) => void
  updatePath: (index: number, path: string) => void
  selectPathPoints?: (indices: number[]) => void
  togglePathPoint?: (segIndex: number) => void
  deletePathPoint?: (segIndex: number) => void
  moveMedianVertex: (strokeIdx: number, ptIdx: number, to: Pt) => void
  addMedianVertex: (strokeIdx: number, at: Pt) => void
  deleteMedianVertex: (strokeIdx: number, ptIdx: number) => void
}

export function useCanvasDrag(options: {
  editableLayer: () => LayerRecord | null
  locked: () => boolean
  selectedIndex: () => number
  activeBBox: () => BBox | null
  transformMode: () => TransformMode
  targetBezierPath: () => string | null
  selectedPathPoints?: () => Set<number>
  overlayScale?: () => number
  setPointMarquee?: (box: PointMarquee | null) => void
  eventToFont: (event: PointerEvent | MouseEvent) => Pt | null
  emit: DragEmit
}) {
  const {
    editableLayer,
    locked,
    selectedIndex,
    activeBBox,
    transformMode,
    targetBezierPath,
    selectedPathPoints = () => new Set<number>(),
    overlayScale = () => 1,
    setPointMarquee = () => {},
    eventToFont,
    emit,
  } = options

  let cleanupDrag: (() => void) | null = null

  function stopActiveDrag() {
    cleanupDrag?.()
    cleanupDrag = null
  }

  onBeforeUnmount(stopActiveDrag)

  // 포인터를 놓을 때까지 창 전체에서 움직임을 받는다. 시작 전에 진행 중이던 드래그는 정리한다.
  function beginDrag(onMove: (moveEvent: PointerEvent) => void, onFinish?: () => void) {
    stopActiveDrag()
    const onUp = () => {
      onFinish?.()
      stopActiveDrag()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    cleanupDrag = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }

  function startMoveDrag(event: PointerEvent) {
    const ed = editableLayer()
    const startPt = eventToFont(event)
    if (!ed || !startPt || locked()) return
    const snapStrokes = cloneStrokesOf(ed.strokes)
    const snapPaths = ed.paths.slice()

    beginDrag((moveEvent) => {
      const cur = eventToFont(moveEvent)
      if (!cur) return
      const dx = cur[0] - startPt[0]
      const dy = cur[1] - startPt[1]
      emit.restoreSnapshot(cloneStrokesOf(snapStrokes), snapPaths.slice())
      emit.transformBy((x, y) => [x + dx, y + dy], 1)
    })
  }

  // 핸들 드래그: 변형 방식(크기/회전/기울임/왜곡)에 따라 점 변환 함수를 만들어 스냅샷에 적용한다.
  function startHandleDrag(dir: ResizeDir, event: PointerEvent) {
    event.stopPropagation()
    const ed = editableLayer()
    const box = activeBBox()
    const startPt = eventToFont(event)
    if (!ed || !box || !startPt || locked()) return

    const snapStrokes = cloneStrokesOf(ed.strokes)
    const snapPaths = ed.paths.slice()
    const initBox = { ...box }
    const mode = transformMode()

    beginDrag((moveEvent) => {
      const cur = eventToFont(moveEvent)
      if (!cur) return
      const { fn, scaleFactor } = dragTransform(mode, initBox, dir, startPt, cur, moveEvent.shiftKey)
      emit.restoreSnapshot(cloneStrokesOf(snapStrokes), snapPaths.slice())
      emit.transformBy(fn, scaleFactor)
    })
  }

  function startBezierAnchorDrag(segIndex: number, event: PointerEvent) {
    event.stopPropagation()
    if (event.button !== 0 || locked()) return
    if (event.altKey) {
      emit.deletePathPoint?.(segIndex)
      return
    }
    if (event.shiftKey) {
      emit.togglePathPoint?.(segIndex)
      return
    }
    const d = targetBezierPath()
    const startPt = eventToFont(event)
    if (!d || !startPt) return
    const initialSegs: EditableSeg[] = parseEditablePath(d)
    const moving = selectedPathPoints().has(segIndex) ? new Set(selectedPathPoints()) : new Set([segIndex])
    if (!selectedPathPoints().has(segIndex)) {
      emit.selectPathPoints?.([segIndex])
    }
    const targetIdx = selectedIndex()

    beginDrag((moveEvent) => {
      const cur = eventToFont(moveEvent)
      if (!cur) return
      const updated = moveEditableAnchors(initialSegs, moving, cur[0] - startPt[0], cur[1] - startPt[1])
      emit.updatePath(targetIdx, serializeEditablePath(updated))
    })
  }

  function startPointMarqueeDrag(event: PointerEvent) {
    const d = targetBezierPath()
    const origin = eventToFont(event)
    if (!d || !origin || locked()) return
    const additive = event.shiftKey
    const base = additive ? new Set(selectedPathPoints()) : new Set<number>()
    const segs = parseEditablePath(d)
    const minDrag = MARQUEE_MIN_DRAG * overlayScale()
    let moved = false

    beginDrag(
      (moveEvent) => {
        const cur = eventToFont(moveEvent)
        if (!cur) return
        if (!moved && Math.hypot(cur[0] - origin[0], cur[1] - origin[1]) >= minDrag) {
          moved = true
        }
        if (!moved) return
        setPointMarquee({ x0: origin[0], y0: origin[1], x1: cur[0], y1: cur[1] })
        const inBox = anchorIndicesInBox(segs, {
          minX: Math.min(origin[0], cur[0]),
          minY: Math.min(origin[1], cur[1]),
          maxX: Math.max(origin[0], cur[0]),
          maxY: Math.max(origin[1], cur[1]),
        })
        emit.selectPathPoints?.([...new Set([...base, ...inBox])])
      },
      () => {
        setPointMarquee(null)
        if (!moved && !additive) emit.selectPathPoints?.([])
      },
    )
  }

  function startBezierHandleDrag(handle: HandleRef, event: PointerEvent) {
    event.stopPropagation()
    const d = targetBezierPath()
    if (!d || locked()) return
    const initialSegs: EditableSeg[] = parseEditablePath(d)
    const targetIdx = selectedIndex()

    beginDrag((moveEvent) => {
      const cur = eventToFont(moveEvent)
      if (!cur) return
      const updated = moveEditableHandle(initialSegs, handle, cur)
      emit.updatePath(targetIdx, serializeEditablePath(updated))
    })
  }

  function onMedianVertexPointerDown(ptIdx: number, event: PointerEvent) {
    event.stopPropagation()
    if (locked()) return
    if (event.altKey) {
      emit.deleteMedianVertex(selectedIndex(), ptIdx)
      return
    }
    const strokeIdx = selectedIndex()
    beginDrag((moveEvent) => {
      const cur = eventToFont(moveEvent)
      if (!cur) return
      emit.moveMedianVertex(strokeIdx, ptIdx, cur)
    })
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
    startBezierAnchorDrag,
    startPointMarqueeDrag,
    startBezierHandleDrag,
    onMedianVertexPointerDown,
    onMedianLinePointerDown,
  }
}
