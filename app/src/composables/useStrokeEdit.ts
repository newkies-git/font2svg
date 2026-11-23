import { isContourLayer } from '../../shared/layerKind.ts'
import { LAYER_ID } from '../../shared/constants.ts'
import type { Ref } from 'vue'
import { autoFitLayer, autoFitStroke } from '../lib/autoFit.ts'
import { pruneHiddenIndices, remapHiddenAfterDelete, remapHiddenAfterMerge, remapHiddenAfterMove } from '../lib/hiddenItems.ts'
import { moveItem, withCap, withMedianPoints } from '../../shared/strokeOps.ts'
import { toPercent } from '../lib/percent.ts'
import {
  mergeTwoStrokes,
  reverseMedian,
  transformPath,
  transformStroke,
} from '../../shared/vectorEdit.ts'
import type { CapType, LayerRecord, Pt, StrokeRecord } from '../../shared/types.ts'
import { cloneStroke } from './layerClone.ts'
import type { LayerEditorState } from './layerEditorState.ts'
import { useConnectTool } from './useConnectTool.ts'
import { useKnifeTool } from './useKnifeTool.ts'
import { useMedianEdit } from './useMedianEdit.ts'
import { usePathPointEdit } from './usePathPointEdit.ts'

export function useStrokeEdit(
  state: LayerEditorState,
  message: Ref<string>,
  error: Ref<string>,
  guardUnlocked: () => LayerRecord | null,
  markDirty: (layerId: string) => void,
) {
  const {
    shown,
    editableLayer,
    isEditableLocked,
    strokesLayer,
    fontLayer,
    transformScope,
    selectedStrokeIndex,
    hiddenItemsByLayer,
  } = state

  function updateHidden(layerId: string, transform: (set: ReadonlySet<number>) => Set<number>) {
    const cur = hiddenItemsByLayer.value[layerId]
    if (!cur || cur.size === 0) return
    const next = transform(cur)
    if (next.size === 0) {
      const rest = { ...hiddenItemsByLayer.value }
      delete rest[layerId]
      hiddenItemsByLayer.value = rest
      return
    }
    hiddenItemsByLayer.value = { ...hiddenItemsByLayer.value, [layerId]: next }
  }

  function updateTargetStrokes(nextStrokes: StrokeRecord[], statusMsg?: string) {
    const target = guardUnlocked()
    if (!target) return
    target.strokes = nextStrokes.map((s, idx) => ({ ...s, stroke_order: idx + 1 }))
    markDirty(target.id)
    updateHidden(target.id, (set) => pruneHiddenIndices(set, nextStrokes.length))
    if (target.id === LAYER_ID.strokes) {
      shown.value = Math.max(1, Math.min(target.strokes.length, shown.value || target.strokes.length))
    }
    if (selectedStrokeIndex.value >= target.strokes.length) {
      selectedStrokeIndex.value = Math.max(0, target.strokes.length - 1)
    }
    if (statusMsg) message.value = statusMsg
  }

  function updateTargetPaths(nextPaths: string[], statusMsg?: string) {
    const target = guardUnlocked()
    if (!target) return
    target.paths = nextPaths.slice()
    markDirty(target.id)
    updateHidden(target.id, (set) => pruneHiddenIndices(set, nextPaths.length))
    if (selectedStrokeIndex.value >= target.paths.length) {
      selectedStrokeIndex.value = Math.max(0, target.paths.length - 1)
    }
    if (statusMsg) message.value = statusMsg
  }

  // 잠금을 확인하고 index번 획 하나를 복제해 고친 뒤 반영한다. mutate가 null을 돌려주면 아무것도 바꾸지 않는다.
  function editStroke(index: number, mutate: (stroke: StrokeRecord) => StrokeRecord | null, statusMsg?: string): boolean {
    const target = guardUnlocked()
    if (!target || !target.strokes[index]) return false
    const copy = target.strokes.map(cloneStroke)
    const next = mutate(copy[index])
    if (!next) return false
    copy[index] = next
    updateTargetStrokes(copy, statusMsg)
    return true
  }

  function moveStrokeInActive(index: number, delta: number) {
    const target = guardUnlocked()
    if (!target) return
    const next = index + delta
    if (isContourLayer(target)) {
      const moved = moveItem(target.paths, index, delta)
      if (!moved) return
      updateHidden(target.id, (set) => remapHiddenAfterMove(set, index, delta))
      updateTargetPaths(moved, '윤곽 순서를 변경했습니다.')
      selectedStrokeIndex.value = next
      return
    }
    const moved = moveItem(target.strokes, index, delta)
    if (!moved) return
    updateHidden(target.id, (set) => remapHiddenAfterMove(set, index, delta))
    updateTargetStrokes(moved, `${index + 1}획을 ${next + 1}획 위치로 이동했습니다.`)
    selectedStrokeIndex.value = next
  }

  function setStrokeRadical(index: number, value: 0 | 1) {
    const target = guardUnlocked()
    if (!target || !target.strokes[index]) return
    target.strokes[index].is_radical = value
    markDirty(target.id)
  }

  // 기필/수필 모양을 고른다. 윤곽에 반영하는 판단은 withCap이 하고, 적용할 수 없으면 값도 윤곽도 바꾸지 않는다.
  function setStrokeCap(index: number, end: 'start' | 'end', value: CapType) {
    const target = guardUnlocked()
    const stroke = target?.strokes[index]
    if (!target || !stroke) return
    const next = withCap(stroke, end, value)
    if (!next) {
      error.value = '이 획의 끝에는 모양을 적용할 수 없습니다. 중심선과 윤곽을 확인하세요.'
      return
    }
    target.strokes[index] = next
    markDirty(target.id)
  }

  function reverseActiveStrokeMedian(index = selectedStrokeIndex.value) {
    editStroke(index, (stroke) => ({ ...stroke, median_points: reverseMedian(stroke.median_points) }), `${index + 1}획의 기필↔수필 방향을 반전했습니다.`)
  }

  function deleteStrokeAt(index: number) {
    const target = guardUnlocked()
    if (!target) return
    if (isContourLayer(target)) {
      if (target.paths.length <= 1) {
        error.value = '마지막 남은 윤곽은 삭제할 수 없습니다.'
        return
      }
      const copy = target.paths.filter((_, i) => i !== index)
      updateHidden(target.id, (set) => remapHiddenAfterDelete(set, index))
      updateTargetPaths(copy, `${index + 1}번 윤곽을 삭제했습니다.`)
      return
    }
    if (target.strokes.length <= 1) {
      error.value = '최소 1개의 획은 남아 있어야 합니다.'
      return
    }
    const copy = target.strokes.filter((_, i) => i !== index)
    updateHidden(target.id, (set) => remapHiddenAfterDelete(set, index))
    updateTargetStrokes(copy, `${index + 1}획을 삭제했습니다.`)
  }

  function mergeStrokeWithNext(index: number) {
    const target = guardUnlocked()
    if (!target || index < 0 || index + 1 >= target.strokes.length) return
    const copy = target.strokes.map(cloneStroke)
    const merged = mergeTwoStrokes(copy[index], copy[index + 1])
    copy.splice(index, 2, merged)
    updateHidden(target.id, (set) => remapHiddenAfterMerge(set, index))
    updateTargetStrokes(copy, `${index + 1}획과 ${index + 2}획을 병합했습니다.`)
    selectedStrokeIndex.value = index
  }

  function copyStrokeToWorkLayer(index: number) {
    const src = editableLayer.value
    const dst = strokesLayer.value
    if (!src || !dst || src.id === LAYER_ID.strokes) return
    if (dst.locked) {
      error.value = '작업 획 레이어가 잠겨 있습니다. 잠금을 해제한 뒤 복사하세요.'
      return
    }
    const stroke = src.strokes[index]
    if (!stroke) return
    const next = [...dst.strokes.map(cloneStroke), cloneStroke(stroke)].map((s, idx) => ({
      ...s,
      stroke_order: idx + 1,
    }))
    dst.strokes = next
    markDirty(LAYER_ID.strokes)
    shown.value = dst.strokes.length
    message.value = `'${src.name}'의 ${index + 1}획을 작업 획 레이어 끝에 추가했습니다.`
  }

  function restoreActiveSnapshot(strokes: StrokeRecord[], paths: string[]) {
    const target = editableLayer.value
    if (!target || isEditableLocked.value) return
    target.strokes = strokes
    target.paths = paths
  }

  // 궁서체(TTF)는 맞춤·편집의 고정 기준이라 위치·크기를 바꾸지 않는다.
  function rejectFontTransform(target: LayerRecord): boolean {
    if (target.kind !== 'FONT' && target.id !== LAYER_ID.font) return false
    error.value = '궁서체(TTF)는 기준 레이어라 위치·크기를 바꿀 수 없습니다. 다른 레이어를 궁서체에 맞추세요.'
    return true
  }

  // 레이어/획 아핀 변환 적용
  function applyAffineToActive(fn: (x: number, y: number) => Pt, scaleFactor = 1) {
    const target = guardUnlocked()
    if (!target) return
    if (rejectFontTransform(target)) return
    if (isContourLayer(target)) {
      if (transformScope.value === 'stroke' && target.paths[selectedStrokeIndex.value]) {
        const copy = target.paths.slice()
        copy[selectedStrokeIndex.value] = transformPath(copy[selectedStrokeIndex.value], fn)
        updateTargetPaths(copy)
      } else {
        updateTargetPaths(target.paths.map((d) => transformPath(d, fn)))
      }
      return
    }
    if (transformScope.value === 'stroke' && target.strokes[selectedStrokeIndex.value]) {
      const copy = target.strokes.map(cloneStroke)
      copy[selectedStrokeIndex.value] = transformStroke(copy[selectedStrokeIndex.value], fn, scaleFactor)
      updateTargetStrokes(copy)
    } else {
      updateTargetStrokes(target.strokes.map((s) => transformStroke(s, fn, scaleFactor)))
    }
  }

  // 획 윤곽을 그 획이 맡은 궁서체 모양으로 바꾼다. 중심선 점은 그 윤곽을 따르게 다시 잡는다.
  // 전체 변환 범위면 레이어의 획 전부, 단일 획 범위면 선택한 획만 맞춘다.
  function autoFitToFont() {
    const target = guardUnlocked()
    const fl = fontLayer.value
    if (!target || !fl || fl.paths.length === 0) {
      error.value = '맞춤 기준이 될 궁서체(TTF) 윤곽이 없습니다.'
      return
    }
    if (rejectFontTransform(target)) return
    if (target.strokes.length === 0) {
      error.value = '자동으로 맞출 획 데이터가 없습니다.'
      return
    }
    const single = transformScope.value === 'stroke' && Boolean(target.strokes[selectedStrokeIndex.value])
    const result = single
      ? autoFitStroke(target.strokes, fl.paths, selectedStrokeIndex.value)
      : autoFitLayer(target.strokes, fl.paths)
    const percent = (value: number) => `${toPercent(value)}%`
    const subject = single ? `${selectedStrokeIndex.value + 1}획` : `'${target.name}' 레이어`
    if (result.after <= result.before) {
      message.value = `${subject}: 더 나은 위치를 찾지 못했습니다 (겹침 ${percent(result.before)}). 수동으로 대략 맞춘 뒤 다시 시도하세요.`
      return
    }
    updateTargetStrokes(result.strokes, `${subject} 자동 맞춤: 궁서체 겹침 ${percent(result.before)} → ${percent(result.after)}. 윤곽을 궁서체 모양에 맞췄습니다. 확인 후 저장하세요.`)
  }

  // 베지어 편집 결과 반영
  function updateSinglePathInActive(index: number, nextPath: string) {
    const target = guardUnlocked()
    if (!target) return
    if (isContourLayer(target)) {
      if (!target.paths[index]) return
      const copy = target.paths.slice()
      copy[index] = nextPath
      updateTargetPaths(copy)
      return
    }
    editStroke(index, (stroke) => withMedianPoints({ ...stroke, outline_path: nextPath }, stroke.median_points))
  }

  // 중심선·패스 정점 편집 / 칼 / 연결
  const { cancelKnife, applyKnifePoint } = useKnifeTool(state, message, error, guardUnlocked, updateTargetStrokes, updateTargetPaths)
  const { cancelConnect, undoConnectPoint, applyConnectPoint, commitConnectOutline, commitConnectBridge } = useConnectTool(state, message, error, guardUnlocked, updateTargetPaths, editStroke)
  const { moveMedianVertex, addMedianVertex, deleteMedianVertex } = useMedianEdit(state, error, editStroke)
  const pathPoints = usePathPointEdit(state, message, error, updateSinglePathInActive)

  return {
    updateTargetStrokes,
    moveStrokeInActive,
    setStrokeRadical,
    setStrokeCap,
    reverseActiveStrokeMedian,
    deleteStrokeAt,
    mergeStrokeWithNext,
    copyStrokeToWorkLayer,
    restoreActiveSnapshot,
    applyAffineToActive,
    autoFitToFont,
    updateSinglePathInActive,
    ...pathPoints,
    moveMedianVertex,
    addMedianVertex,
    deleteMedianVertex,
    cancelKnife,
    applyKnifePoint,
    cancelConnect,
    undoConnectPoint,
    applyConnectPoint,
    commitConnectOutline,
    commitConnectBridge,
  }
}
