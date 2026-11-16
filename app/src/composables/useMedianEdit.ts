import type { Ref } from 'vue'
import { roundPt, withMedianPoints } from '../lib/strokeOps.ts'
import { insertMedianPoint, removeMedianPoint } from '../lib/vectorEdit.ts'
import type { Pt, StrokeRecord } from '../../shared/types.ts'
import type { LayerEditorState } from './layerEditorState.ts'

// 중심선은 최소 이 개수의 정점이 있어야 한다.
const MIN_MEDIAN_VERTICES = 2

// 중심선(median) 정점 편집: 옮기기·추가·삭제. 정점을 바꾸면 그 중심선에 맞게 획 폭도 다시 계산한다.
// editStroke는 잠금을 확인하고 획 하나를 복제해 고친 뒤 반영한다(mutate가 null이면 아무것도 바꾸지 않는다).
export function useMedianEdit(
  state: LayerEditorState,
  error: Ref<string>,
  editStroke: (index: number, mutate: (stroke: StrokeRecord) => StrokeRecord | null, statusMsg?: string) => boolean,
) {
  const { selectedMedianPointIndex } = state

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
      if (stroke.median_points.length <= MIN_MEDIAN_VERTICES) {
        error.value = '중심선은 최소 2개의 정점이 필요합니다.'
        return null
      }
      return withMedianPoints(stroke, removeMedianPoint(stroke.median_points, ptIdx))
    }, `${strokeIdx + 1}획 중심선 정점을 삭제했습니다.`)
    if (done) selectedMedianPointIndex.value = null
  }

  return { moveMedianVertex, addMedianVertex, deleteMedianVertex }
}
