import { isContourLayer } from '../../shared/layerKind.ts'
import { computed, type Ref } from 'vue'
import {
  canDeleteAnchors,
  deleteEditableAnchors,
  expandSeamPartners,
  insertPathPointAt,
  insertPathPointOnSelection,
  moveEditableAnchors,
  simplifyEditablePath,
  togglePathSegmentCurve,
} from '../lib/pathPointEdit.ts'
import { parseEditablePath, serializeEditablePath } from '../../shared/vectorEdit.ts'
import type { Pt } from '../../shared/types.ts'
import type { LayerEditorState } from './layerEditorState.ts'

export function usePathPointEdit(
  state: LayerEditorState,
  message: Ref<string>,
  error: Ref<string>,
  updateSinglePathInActive: (index: number, nextPath: string) => void,
) {
  const { editableLayer, isEditableLocked, selectedStrokeIndex, selectedPathPoints } = state

  function pathAt(index: number): string | null {
    const ed = editableLayer.value
    if (!ed) return null
    return isContourLayer(ed) ? (ed.paths[index] ?? null) : (ed.strokes[index]?.outline_path ?? null)
  }

  function activePath(): string | null {
    return pathAt(selectedStrokeIndex.value)
  }

  const canDeleteSelectedPathPoints = computed(() => {
    const d = activePath()
    return Boolean(d && selectedPathPoints.value.size > 0 && canDeleteAnchors(parseEditablePath(d), selectedPathPoints.value))
  })

  function setPathPointSelection(indices: Iterable<number>) {
    const d = activePath()
    if (!d) {
      selectedPathPoints.value = new Set()
      return
    }
    selectedPathPoints.value = expandSeamPartners(parseEditablePath(d), indices)
  }

  function togglePathPointSelection(segIndex: number) {
    const d = activePath()
    if (!d) return
    const segs = parseEditablePath(d)
    const group = expandSeamPartners(segs, [segIndex])
    if (group.size === 0) return
    const next = new Set(selectedPathPoints.value)
    const removing = next.has(segIndex)
    for (const idx of group) {
      if (removing) next.delete(idx)
      else next.add(idx)
    }
    selectedPathPoints.value = next
  }

  function clearPathPointSelection() {
    selectedPathPoints.value = new Set()
  }

  function nudgeSelectedPathPoints(dx: number, dy: number) {
    if (selectedPathPoints.value.size === 0 || isEditableLocked.value) return
    const d = activePath()
    if (!d) return
    const next = moveEditableAnchors(parseEditablePath(d), selectedPathPoints.value, dx, dy)
    updateSinglePathInActive(selectedStrokeIndex.value, serializeEditablePath(next))
  }

  function insertPathPointAtPos(strokeIdx: number, at: Pt) {
    if (isEditableLocked.value) return
    const d = pathAt(strokeIdx)
    if (!d) return
    const segs = parseEditablePath(d)
    const res = insertPathPointAt(segs, at)
    if (!res) return
    updateSinglePathInActive(strokeIdx, serializeEditablePath(res.segs))
    selectedPathPoints.value = expandSeamPartners(res.segs, [res.insertedIndex])
    message.value = '윤곽에 새 패스 정점을 추가했습니다.'
  }

  function insertPathPointFromSelection() {
    if (isEditableLocked.value) return
    const d = activePath()
    if (!d) return
    const segs = parseEditablePath(d)
    const res = insertPathPointOnSelection(segs, selectedPathPoints.value)
    if (!res) return
    updateSinglePathInActive(selectedStrokeIndex.value, serializeEditablePath(res.segs))
    selectedPathPoints.value = expandSeamPartners(res.segs, res.insertedIndices)
    message.value = `패스 정점 ${res.insertedIndices.length}개를 추가했습니다.`
  }

  function toggleSelectedPathCurve() {
    if (isEditableLocked.value) return
    const d = activePath()
    if (!d) return
    const next = togglePathSegmentCurve(parseEditablePath(d), selectedPathPoints.value)
    if (!next) {
      error.value = '곡선·직선으로 변환할 구간이 없습니다. 정점을 먼저 선택하세요.'
      return
    }
    updateSinglePathInActive(selectedStrokeIndex.value, serializeEditablePath(next))
    message.value = '선택한 구간의 직선↔곡선을 전환했습니다.'
  }

  function deletePathPointAt(segIndex: number) {
    if (isEditableLocked.value) return
    const d = activePath()
    if (!d) return
    const next = deleteEditableAnchors(parseEditablePath(d), [segIndex])
    if (!next) {
      error.value = '닫힌 윤곽은 최소 3개의 정점이 필요합니다.'
      return
    }
    updateSinglePathInActive(selectedStrokeIndex.value, serializeEditablePath(next))
    selectedPathPoints.value = new Set()
    message.value = '선택한 패스 정점을 삭제했습니다.'
  }

  function deleteSelectedPathPoints() {
    if (isEditableLocked.value || selectedPathPoints.value.size === 0) return
    const d = activePath()
    if (!d) return
    const next = deleteEditableAnchors(parseEditablePath(d), selectedPathPoints.value)
    if (!next) {
      error.value = '닫힌 윤곽은 최소 3개의 정점이 필요합니다.'
      return
    }
    updateSinglePathInActive(selectedStrokeIndex.value, serializeEditablePath(next))
    selectedPathPoints.value = new Set()
    message.value = '선택한 패스 정점을 삭제했습니다.'
  }

  function simplifySelectedPathPoints() {
    if (isEditableLocked.value) return
    const d = activePath()
    if (!d) return
    const segs = parseEditablePath(d)
    const next = simplifyEditablePath(segs, selectedPathPoints.value)
    if (!next) {
      message.value = '더 이상 단순화할 직선 정점이 없습니다.'
      return
    }
    updateSinglePathInActive(selectedStrokeIndex.value, serializeEditablePath(next))
    selectedPathPoints.value = new Set()
    message.value = `직선 정점을 ${segs.length - next.length}개 줄였습니다.`
  }

  return {
    canDeleteSelectedPathPoints,
    setPathPointSelection,
    togglePathPointSelection,
    clearPathPointSelection,
    nudgeSelectedPathPoints,
    insertPathPointAtPos,
    insertPathPointFromSelection,
    toggleSelectedPathCurve,
    simplifySelectedPathPoints,
    deletePathPointAt,
    deleteSelectedPathPoints,
  }
}
