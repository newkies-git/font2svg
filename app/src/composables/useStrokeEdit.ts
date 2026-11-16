import { isContourLayer } from '../../shared/layerKind.ts'
import { LAYER_ID } from '../../shared/constants.ts'
import type { Ref } from 'vue'
import { autoFitLayer, autoFitStroke } from '../lib/autoFit.ts'
import { applyCapShape, extractStrokeAlongGuide, isCapShape, splitStrokeByKnife } from '../../shared/strokeCut.ts'
import { boxAlignTransform, extractStrokeAtGuide, moveItem, pointsToClosedPath, restrokeFromOutline, roundPt, splitStrokeAtKnife, withMedianPoints } from '../lib/strokeOps.ts'
import {
  insertMedianPoint,
  mergeTwoStrokes,
  pathsBBox,
  removeMedianPoint,
  reverseMedian,
  strokesBBox,
  transformPath,
  transformStroke,
} from '../lib/vectorEdit.ts'
import type { CapType, LayerRecord, Pt, StrokeRecord } from '../../shared/types.ts'
import { cloneStroke } from './layerClone.ts'
import type { LayerEditorState } from './layerEditorState.ts'

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
    selectedMedianPointIndex,
    knifePoints,
    knifeMode,
    connectPoints,
  } = state

  function updateTargetStrokes(nextStrokes: StrokeRecord[], statusMsg?: string) {
    const target = guardUnlocked()
    if (!target) return
    target.strokes = nextStrokes.map((s, idx) => ({ ...s, stroke_order: idx + 1 }))
    markDirty(target.id)
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
      updateTargetPaths(moved, '윤곽 순서를 변경했습니다.')
      selectedStrokeIndex.value = next
      return
    }
    const moved = moveItem(target.strokes, index, delta)
    if (!moved) return
    updateTargetStrokes(moved, `${index + 1}획을 ${next + 1}획 위치로 이동했습니다.`)
    selectedStrokeIndex.value = next
  }

  function setStrokeRadical(index: number, value: 0 | 1) {
    const target = guardUnlocked()
    if (!target || !target.strokes[index]) return
    target.strokes[index].is_radical = value
    markDirty(target.id)
  }

  // 기필/수필 모양을 고른다. 모양(둥글게 등)은 그 끝의 윤곽에 바로 반영하고, 모양에서 기본으로 돌아오면 끝을 되돌린다.
  // 도장·직접 그리기는 값만 기록한다(직접 그리기는 화면에서 꼭짓점 편집 도구로 이어진다).
  function setStrokeCap(index: number, end: 'start' | 'end', value: CapType) {
    const target = guardUnlocked()
    const stroke = target?.strokes[index]
    if (!target || !stroke) return
    const key = end === 'start' ? 'start_cap_type' : 'end_cap_type'
    const restore = isCapShape(stroke[key])
    if (isCapShape(value) || (value === 'NONE' && restore)) {
      const outline = applyCapShape(stroke.outline_path, stroke.median_points, end, isCapShape(value) ? value : null, stroke.stroke_width, restore)
      if (!outline) {
        error.value = '이 획의 끝에는 모양을 적용할 수 없습니다. 중심선과 윤곽을 확인하세요.'
        return
      }
      stroke.outline_path = outline
    }
    stroke[key] = value
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
      updateTargetPaths(copy, `${index + 1}번 윤곽을 삭제했습니다.`)
      return
    }
    if (target.strokes.length <= 1) {
      error.value = '최소 1개의 획은 남아 있어야 합니다.'
      return
    }
    const copy = target.strokes.filter((_, i) => i !== index)
    updateTargetStrokes(copy, `${index + 1}획을 삭제했습니다.`)
  }

  function mergeStrokeWithNext(index: number) {
    const target = guardUnlocked()
    if (!target || index < 0 || index + 1 >= target.strokes.length) return
    const copy = target.strokes.map(cloneStroke)
    const merged = mergeTwoStrokes(copy[index], copy[index + 1])
    copy.splice(index, 2, merged)
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

  // 레이어/획 아핀 변환 적용
  function applyAffineToActive(fn: (x: number, y: number) => Pt, scaleFactor = 1) {
    const target = guardUnlocked()
    if (!target) return
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

  // 선택된 레퍼런스/획 레이어를 궁서체(FONT) 바운딩 박스에 원클릭 정렬
  function alignActiveToFont() {
    const target = guardUnlocked()
    const fl = fontLayer.value
    if (!target || !fl || fl.paths.length === 0) {
      error.value = '정렬 기준이 될 궁서체(TTF) 윤곽이 없습니다.'
      return
    }
    const fontBox = pathsBBox(fl.paths)
    const srcBox = target.strokes.length > 0 ? strokesBBox(target.strokes) : pathsBBox(target.paths)
    if (!fontBox || !srcBox) return
    const { map, scale } = boxAlignTransform(fontBox, srcBox)
    applyAffineToActive(map, scale)
    message.value = `'${target.name}' 레이어의 위치·크기를 궁서체 윤곽 영역에 맞췄습니다.`
  }

  // 겹침 비율(IoU)을 최대화해 활성 레이어를 궁서체 윤곽에 자동으로 맞춘다.
  // 전체 변환 범위면 레이어 전체(+획별 보정), 단일 획 범위면 선택한 획만 맞춘다.
  function autoFitToFont() {
    const target = guardUnlocked()
    const fl = fontLayer.value
    if (!target || !fl || fl.paths.length === 0) {
      error.value = '맞춤 기준이 될 궁서체(TTF) 윤곽이 없습니다.'
      return
    }
    if (target.strokes.length === 0) {
      error.value = '자동으로 맞출 획 데이터가 없습니다.'
      return
    }
    const single = transformScope.value === 'stroke' && Boolean(target.strokes[selectedStrokeIndex.value])
    const result = single
      ? autoFitStroke(target.strokes, fl.paths, selectedStrokeIndex.value)
      : autoFitLayer(target.strokes, fl.paths)
    const percent = (value: number) => `${Math.round(value * 100)}%`
    const subject = single ? `${selectedStrokeIndex.value + 1}획` : `'${target.name}' 레이어`
    if (result.after <= result.before) {
      message.value = `${subject}: 더 나은 위치를 찾지 못했습니다 (겹침 ${percent(result.before)}). 수동으로 대략 맞춘 뒤 다시 시도하세요.`
      return
    }
    updateTargetStrokes(result.strokes, `${subject} 자동 맞춤: 궁서체 겹침 ${percent(result.before)} → ${percent(result.after)}. 확인 후 저장하세요.`)
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

  // 중심선 정점 이동 / 추가 / 삭제
  function moveMedianVertex(strokeIdx: number, ptIdx: number, to: Pt) {
    editStroke(strokeIdx, (stroke) => {
      if (!stroke.median_points[ptIdx]) return null
      const points = stroke.median_points.slice()
      points[ptIdx] = roundPt(to)
      return withMedianPoints(stroke, points)
    })
  }

  function addMedianVertex(strokeIdx: number, at: Pt) {
    let insertedAt = 0
    const done = editStroke(strokeIdx, (stroke) => {
      const { points, insertedIndex } = insertMedianPoint(stroke.median_points, at)
      insertedAt = insertedIndex
      return withMedianPoints(stroke, points)
    }, `${strokeIdx + 1}획 중심선에 정점을 추가했습니다.`)
    if (done) selectedMedianPointIndex.value = insertedAt
  }

  function deleteMedianVertex(strokeIdx: number, ptIdx: number) {
    const done = editStroke(strokeIdx, (stroke) => {
      if (stroke.median_points.length <= 2) {
        error.value = '중심선은 최소 2개의 정점이 필요합니다.'
        return null
      }
      return withMedianPoints(stroke, removeMedianPoint(stroke.median_points, ptIdx))
    }, `${strokeIdx + 1}획 중심선 정점을 삭제했습니다.`)
    if (done) selectedMedianPointIndex.value = null
  }

  // 칼 분할 (모든 잠금 해제된 획 레이어 및 FONT 윤곽 레이어 지원)
  function cancelKnife() {
    knifePoints.value = []
    message.value = '획 분할이 취소되었습니다.'
  }

  // 칼 점을 더한다. 일반 클릭은 끝점이라 바로 가르고, extend(Shift+클릭)는 꺾는 점을 더하고 계속한다.
  // 칼 모드가 extract(교차 분리)면 점들은 칼이 아니라 분리할 획의 중심을 따르는 안내선이다.
  function applyKnifePoint(point: Pt, extend = false) {
    const target = guardUnlocked()
    if (!target) return

    if (knifePoints.value.length === 0) {
      knifePoints.value = [point]
      message.value = '칼 분할: 다음 점을 클릭하세요. 끝점은 클릭, 꺾는 점은 Shift+클릭 (Esc 취소)'
      return
    }
    if (extend) {
      knifePoints.value = [...knifePoints.value, point]
      message.value = `칼 분할: 점 ${knifePoints.value.length}개 — 끝점은 클릭, 꺾는 점은 Shift+클릭 (Esc 취소)`
      return
    }

    const knife = [...knifePoints.value, point].map(([x, y]) => ({ x, y }))
    const extract = knifeMode.value === 'extract'
    knifePoints.value = []

    if (isContourLayer(target)) {
      const idx = selectedStrokeIndex.value
      const d = target.paths[idx]
      if (!d) return
      const extracted = extract ? extractStrokeAlongGuide(d, knife) : null
      const paths = extract ? (extracted ? [...extracted.stroke, ...extracted.rest] : null) : splitStrokeByKnife(d, knife)?.map((part) => part.path) ?? null
      if (!paths) {
        error.value = extract
          ? '교차 분리 불가: 분리할 획의 중심을 지나도록 안내선 점을 지정하세요.'
          : '윤곽 분할 불가: 선택한 윤곽 외곽선과 교차하도록 칼 점을 지정하세요.'
        return
      }
      const copy = target.paths.slice()
      copy.splice(idx, 1, ...paths)
      updateTargetPaths(copy, `윤곽을 ${paths.length}개로 ${extract ? '나눴습니다(교차 분리)' : '분할했습니다'}. [레이어 저장]을 누르면 반영됩니다.`)
      return
    }

    const idx = selectedStrokeIndex.value
    const stroke = target.strokes[idx]
    if (!stroke) return
    const parts = extract ? extractStrokeAtGuide(stroke, knife) : splitStrokeAtKnife(stroke, knife)
    if (!parts) {
      error.value = extract
        ? '교차 분리 불가: 분리할 획의 중심을 지나도록 안내선 점을 지정하세요.'
        : '획 분할 불가: 선택된 획의 외곽선과 교차하도록 칼 점을 지정하세요.'
      return
    }
    const pieces = parts.map((piece): StrokeRecord => ({
      ...piece,
      // 획 윤곽(OUTLINE) 레이어에서 나이프로 가른 조각은 사람이 만든 매핑이라 자동 매핑이 덮어쓰지 않는다.
      ...(target.kind === 'OUTLINE' ? { map_manual: 1 as const } : {}),
    }))
    const copy = target.strokes.map(cloneStroke)
    copy.splice(idx, 1, ...pieces)
    updateTargetStrokes(copy, extract
      ? `${idx + 1}획을 ${pieces.length}개로 나눴습니다(교차 분리). 교차부는 두 획이 함께 가집니다. [레이어 저장]을 누르면 반영됩니다.`
      : `${idx + 1}획을 ${pieces.length}개로 분할했습니다. 단면이 획의 끝이면 기필·수필 모양이 붙습니다. [레이어 저장]을 누르면 반영됩니다.`)
    selectedStrokeIndex.value = idx + 1
    if (target.id === LAYER_ID.strokes) shown.value = idx + pieces.length
  }

  function cancelConnect() {
    if (connectPoints.value.length === 0) return
    connectPoints.value = []
    message.value = '윤곽 연결이 취소되었습니다.'
  }

  function undoConnectPoint() {
    if (connectPoints.value.length === 0) return
    connectPoints.value = connectPoints.value.slice(0, -1)
    message.value =
      connectPoints.value.length === 0
        ? '윤곽 연결: 시작점을 클릭하세요.'
        : `윤곽 연결: ${connectPoints.value.length}점 지정됨 (Enter 연결 · ⌫ 되돌리기 · Esc 취소)`
  }

  function applyConnectPoint(point: Pt) {
    const target = guardUnlocked()
    if (!target) return
    const next = roundPt(point)
    const prev = connectPoints.value[connectPoints.value.length - 1]
    if (prev && Math.hypot(prev[0] - next[0], prev[1] - next[1]) < 1.5) return
    connectPoints.value = [...connectPoints.value, next]
    const n = connectPoints.value.length
    if (n === 1) message.value = '윤곽 연결: 중간점 또는 끝점을 클릭하세요.'
    else if (n === 2) message.value = '윤곽 연결: 끝점(또는 추가 중간점)을 클릭하세요. 3점 이상이면 Enter로 연결.'
    else message.value = `윤곽 연결: ${n}점 지정됨 — Enter/더블클릭으로 닫힌 윤곽 연결 (⌫ 되돌리기 · Esc 취소)`
  }

  function commitConnectOutline() {
    const target = guardUnlocked()
    if (!target) return
    if (connectPoints.value.length < 3) {
      error.value = '윤곽 연결에는 시작·중간·끝 포함 최소 3점이 필요합니다.'
      return
    }
    const path = pointsToClosedPath(connectPoints.value)
    connectPoints.value = []
    const idx = selectedStrokeIndex.value

    if (isContourLayer(target)) {
      if (!target.paths[idx]) return
      const copy = target.paths.slice()
      copy[idx] = path
      updateTargetPaths(copy, '윤곽을 지정한 점으로 다시 연결했습니다. [레이어 저장]을 누르면 반영됩니다.')
      return
    }

    editStroke(idx, (stroke) => restrokeFromOutline(stroke, path), `${idx + 1}획 윤곽을 지정한 점으로 다시 연결했습니다. [레이어 저장]을 누르면 반영됩니다.`)
  }

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
    alignActiveToFont,
    autoFitToFont,
    updateSinglePathInActive,
    moveMedianVertex,
    addMedianVertex,
    deleteMedianVertex,
    cancelKnife,
    applyKnifePoint,
    cancelConnect,
    undoConnectPoint,
    applyConnectPoint,
    commitConnectOutline,
  }
}
