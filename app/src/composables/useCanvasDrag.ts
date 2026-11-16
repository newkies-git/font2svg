import { onBeforeUnmount } from 'vue'
import {
  moveEditableHandle,
  parseEditablePath,
  serializeEditablePath,
  type BBox,
  type EditableSeg,
  type HandleRef,
} from '../lib/vectorEdit.ts'
import { dragTransform, type HandleDir, type TransformMode } from '../lib/transformMath.ts'
import type { LayerRecord, Pt, StrokeRecord } from '../../shared/types.ts'
import { cloneStroke } from './layerClone.ts'

const cloneStrokesOf = (list: StrokeRecord[]): StrokeRecord[] => list.map(cloneStroke)

export type ResizeDir = HandleDir

type DragEmit = {
  restoreSnapshot: (strokes: StrokeRecord[], paths: string[]) => void
  transformBy: (fn: (x: number, y: number) => Pt, scaleFactor: number) => void
  updatePath: (index: number, path: string) => void
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

  // 포인터를 놓을 때까지 창 전체에서 움직임을 받는다. 시작 전에 진행 중이던 드래그는 정리한다.
  function beginDrag(onMove: (moveEvent: PointerEvent) => void) {
    stopActiveDrag()
    const onUp = () => stopActiveDrag()
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
    startBezierHandleDrag,
    onMedianVertexPointerDown,
    onMedianLinePointerDown,
  }
}
