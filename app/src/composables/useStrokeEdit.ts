import { isContourLayer } from '../lib/layerKind.ts'
import { LAYER_ID } from '../lib/constants.ts'
import type { Ref } from 'vue'
import { autoFitLayer, autoFitStroke } from '../lib/autoFit.ts'
import { round1 } from '../lib/paths.ts'
import { recoverMedian, splitStrokeByKnife } from '../lib/strokeCut.ts'
import {
  insertMedianPoint,
  mergeTwoStrokes,
  pathsBBox,
  recomputeStrokeWidth,
  removeMedianPoint,
  reverseMedian,
  strokesBBox,
  transformPath,
  transformStroke,
} from '../lib/vectorEdit.ts'
import type { CapType, LayerRecord, Pt, StrokeRecord } from '../types.ts'
import { cloneStroke } from './layerClone.ts'
import type { LayerEditorState } from './layerEditorState.ts'

function roundPt(p: Pt): Pt {
  return [round1(p[0]), round1(p[1])]
}

function pointsToClosedPath(points: Pt[]): string {
  const pts = points.map(roundPt)
  const [x0, y0] = pts[0]
  let d = `M ${x0} ${y0}`
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0]} ${pts[i][1]}`
  return `${d} Z`
}

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
    knifeFrom,
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

  function moveStrokeInActive(index: number, delta: number) {
    const target = guardUnlocked()
    if (!target) return
    if (isContourLayer(target)) {
      const next = index + delta
      if (next < 0 || next >= target.paths.length) return
      const copy = target.paths.slice()
      const [item] = copy.splice(index, 1)
      copy.splice(next, 0, item)
      updateTargetPaths(copy, '윤곽 순서를 변경했습니다.')
      selectedStrokeIndex.value = next
      return
    }
    const next = index + delta
    if (next < 0 || next >= target.strokes.length) return
    const copy = target.strokes.slice()
    const [item] = copy.splice(index, 1)
    copy.splice(next, 0, item)
    updateTargetStrokes(copy, `${index + 1}획을 ${next + 1}획 위치로 이동했습니다.`)
    selectedStrokeIndex.value = next
  }

  function setStrokeRadical(index: number, value: 0 | 1) {
    const target = guardUnlocked()
    if (!target || !target.strokes[index]) return
    target.strokes[index].is_radical = value
    markDirty(target.id)
  }

  function setStrokeCap(index: number, end: 'start' | 'end', value: CapType) {
    const target = guardUnlocked()
    if (!target || !target.strokes[index]) return
    if (end === 'start') target.strokes[index].start_cap_type = value
    else target.strokes[index].end_cap_type = value
    markDirty(target.id)
  }

  function reverseActiveStrokeMedian(index = selectedStrokeIndex.value) {
    const target = guardUnlocked()
    if (!target || !target.strokes[index]) return
    const copy = target.strokes.map(cloneStroke)
    copy[index].median_points = reverseMedian(copy[index].median_points)
    updateTargetStrokes(copy, `${index + 1}획의 기필↔수필 방향을 반전했습니다.`)
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
    const sw = Math.max(1, srcBox.maxX - srcBox.minX)
    const sh = Math.max(1, srcBox.maxY - srcBox.minY)
    const sx = (fontBox.maxX - fontBox.minX) / sw
    const sy = (fontBox.maxY - fontBox.minY) / sh
    applyAffineToActive(
      (x, y) => [fontBox.minX + (x - srcBox.minX) * sx, fontBox.minY + (y - srcBox.minY) * sy],
      (sx + sy) / 2,
    )
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
    if (!target.strokes[index]) return
    const copy = target.strokes.map(cloneStroke)
    copy[index].outline_path = nextPath
    copy[index].stroke_width = recomputeStrokeWidth(nextPath, copy[index].median_points, copy[index].stroke_width)
    updateTargetStrokes(copy)
  }

  // 중심선 정점 이동 / 추가 / 삭제
  function moveMedianVertex(strokeIdx: number, ptIdx: number, to: Pt) {
    const target = guardUnlocked()
    if (!target || !target.strokes[strokeIdx]) return
    const copy = target.strokes.map(cloneStroke)
    const pts = copy[strokeIdx].median_points
    if (!pts[ptIdx]) return
    pts[ptIdx] = roundPt(to)
    copy[strokeIdx].stroke_width = recomputeStrokeWidth(copy[strokeIdx].outline_path, pts, copy[strokeIdx].stroke_width)
    updateTargetStrokes(copy)
  }

  function addMedianVertex(strokeIdx: number, at: Pt) {
    const target = guardUnlocked()
    if (!target || !target.strokes[strokeIdx]) return
    const copy = target.strokes.map(cloneStroke)
    const { points, insertedIndex } = insertMedianPoint(copy[strokeIdx].median_points, at)
    copy[strokeIdx].median_points = points
    copy[strokeIdx].stroke_width = recomputeStrokeWidth(copy[strokeIdx].outline_path, points, copy[strokeIdx].stroke_width)
    selectedMedianPointIndex.value = insertedIndex
    updateTargetStrokes(copy, `${strokeIdx + 1}획 중심선에 정점을 추가했습니다.`)
  }

  function deleteMedianVertex(strokeIdx: number, ptIdx: number) {
    const target = guardUnlocked()
    if (!target || !target.strokes[strokeIdx]) return
    const cur = target.strokes[strokeIdx].median_points
    if (cur.length <= 2) {
      error.value = '중심선은 최소 2개의 정점이 필요합니다.'
      return
    }
    const copy = target.strokes.map(cloneStroke)
    copy[strokeIdx].median_points = removeMedianPoint(cur, ptIdx)
    copy[strokeIdx].stroke_width = recomputeStrokeWidth(
      copy[strokeIdx].outline_path,
      copy[strokeIdx].median_points,
      copy[strokeIdx].stroke_width,
    )
    selectedMedianPointIndex.value = null
    updateTargetStrokes(copy, `${strokeIdx + 1}획 중심선 정점을 삭제했습니다.`)
  }

  // 칼 분할 (모든 잠금 해제된 획 레이어 및 FONT 윤곽 레이어 지원)
  function cancelKnife() {
    knifeFrom.value = null
    message.value = '획 분할이 취소되었습니다.'
  }

  function applyKnifePoint(point: Pt) {
    const target = guardUnlocked()
    if (!target) return

    if (!knifeFrom.value) {
      knifeFrom.value = point
      message.value = '칼 분할: 자를 끝점을 클릭하세요. (Esc 취소)'
      return
    }

    const from = { x: knifeFrom.value[0], y: knifeFrom.value[1] }
    const to = { x: point[0], y: point[1] }
    knifeFrom.value = null

    if (isContourLayer(target)) {
      const idx = selectedStrokeIndex.value
      const d = target.paths[idx]
      if (!d) return
      const parts = splitStrokeByKnife(d, from, to)
      if (!parts) {
        error.value = '윤곽 분할 불가: 선택한 윤곽 외곽선과 교차하도록 두 점을 지정하세요.'
        return
      }
      const copy = target.paths.slice()
      copy.splice(idx, 1, parts[0], parts[1])
      updateTargetPaths(copy, `윤곽을 2개로 분할했습니다. [레이어 저장]을 누르면 반영됩니다.`)
      return
    }

    const idx = selectedStrokeIndex.value
    const stroke = target.strokes[idx]
    if (!stroke) return
    const parts = splitStrokeByKnife(stroke.outline_path, from, to)
    if (!parts) {
      error.value = '획 분할 불가: 선택된 획의 외곽선과 교차하도록 두 점을 지정하세요.'
      return
    }
    const [left, right] = parts.map((path): StrokeRecord => {
      const median = recoverMedian(path, stroke.stroke_width)
      const pts = median.median.map((p): Pt => roundPt([p.x, p.y]))
      return {
        ...stroke,
        outline_path: path,
        median_points: pts.length >= 2 ? pts : stroke.median_points,
        stroke_width: median.width,
        // 획 윤곽(OUTLINE) 레이어에서 나이프로 가른 조각은 사람이 만든 매핑이라 자동 매핑이 덮어쓰지 않는다.
        ...(target.kind === 'OUTLINE' ? { map_manual: 1 as const } : {}),
      }
    })
    const copy = target.strokes.map(cloneStroke)
    copy.splice(idx, 1, left, right)
    updateTargetStrokes(copy, `${idx + 1}획을 2개로 분할했습니다. [레이어 저장]을 누르면 반영됩니다.`)
    selectedStrokeIndex.value = idx + 1
    if (target.id === LAYER_ID.strokes) shown.value = idx + 2
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

    const stroke = target.strokes[idx]
    if (!stroke) return
    const median = recoverMedian(path, stroke.stroke_width)
    const pts = median.median.map((p): Pt => roundPt([p.x, p.y]))
    const copy = target.strokes.map(cloneStroke)
    copy[idx] = {
      ...copy[idx],
      outline_path: path,
      median_points: pts.length >= 2 ? pts : copy[idx].median_points,
      stroke_width: median.width,
    }
    updateTargetStrokes(copy, `${idx + 1}획 윤곽을 지정한 점으로 다시 연결했습니다. [레이어 저장]을 누르면 반영됩니다.`)
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
