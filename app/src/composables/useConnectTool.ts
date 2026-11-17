import { isContourLayer } from '../../shared/layerKind.ts'
import type { Ref } from 'vue'
import { pointsToClosedPath, restrokeFromOutline, roundPt } from '../lib/strokeOps.ts'
import type { LayerRecord, Pt, StrokeRecord } from '../../shared/types.ts'
import type { LayerEditorState } from './layerEditorState.ts'

// 윤곽 연결에 필요한 최소 점 수(시작·중간·끝)
export const MIN_CONNECT_POINTS = 3
// 앞 점과 이 거리(저장 좌표) 안쪽이면 같은 점을 다시 찍은 것으로 보고 무시한다.
const MIN_CONNECT_POINT_GAP = 1.5
const CONNECT_KEYS_HINT = 'Enter 연결 · ⌫ 되돌리기 · Esc 취소'
const SAVE_HINT = '[레이어 저장]을 누르면 반영됩니다.'

// 윤곽 연결 도구: 점을 찍어 닫힌 윤곽을 만들고, 선택한 윤곽(또는 획의 윤곽)을 그 모양으로 바꾼다.
export function useConnectTool(
  state: LayerEditorState,
  message: Ref<string>,
  error: Ref<string>,
  guardUnlocked: () => LayerRecord | null,
  updateTargetPaths: (paths: string[], statusMsg?: string) => void,
  editStroke: (index: number, mutate: (stroke: StrokeRecord) => StrokeRecord | null, statusMsg?: string) => boolean,
) {
  const { selectedStrokeIndex, connectPoints } = state

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
        : `윤곽 연결: ${connectPoints.value.length}점 지정됨 (${CONNECT_KEYS_HINT})`
  }

  function applyConnectPoint(point: Pt) {
    const target = guardUnlocked()
    if (!target) return
    const next = roundPt(point)
    const prev = connectPoints.value[connectPoints.value.length - 1]
    if (prev && Math.hypot(prev[0] - next[0], prev[1] - next[1]) < MIN_CONNECT_POINT_GAP) return
    connectPoints.value = [...connectPoints.value, next]
    const n = connectPoints.value.length
    if (n === 1) message.value = '윤곽 연결: 중간점 또는 끝점을 클릭하세요.'
    else if (n === 2) message.value = '윤곽 연결: 끝점(또는 추가 중간점)을 클릭하세요. 3점 이상이면 Enter로 연결.'
    else message.value = `윤곽 연결: ${n}점 지정됨 — Enter/더블클릭으로 닫힌 윤곽 연결 (⌫ 되돌리기 · Esc 취소)`
  }

  function commitConnectOutline() {
    const target = guardUnlocked()
    if (!target) return
    if (connectPoints.value.length < MIN_CONNECT_POINTS) {
      error.value = `윤곽 연결에는 시작·중간·끝 포함 최소 ${MIN_CONNECT_POINTS}점이 필요합니다.`
      return
    }
    const path = pointsToClosedPath(connectPoints.value)
    connectPoints.value = []
    const idx = selectedStrokeIndex.value

    if (isContourLayer(target)) {
      if (!target.paths[idx]) return
      const copy = target.paths.slice()
      copy[idx] = path
      updateTargetPaths(copy, `윤곽을 지정한 점으로 다시 연결했습니다. ${SAVE_HINT}`)
      return
    }

    editStroke(idx, (stroke) => restrokeFromOutline(stroke, path), `${idx + 1}획 윤곽을 지정한 점으로 다시 연결했습니다. ${SAVE_HINT}`)
  }

  return { cancelConnect, undoConnectPoint, applyConnectPoint, commitConnectOutline }
}
