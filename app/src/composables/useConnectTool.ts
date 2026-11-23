import { isContourLayer } from '../../shared/layerKind.ts'
import { spliceOutlineBridge } from '../../shared/strokeCut.ts'
import type { Ref } from 'vue'
import { pointsToClosedPath, restrokeFromOutline, roundPt } from '../../shared/strokeOps.ts'
import type { LayerRecord, Pt, StrokeRecord } from '../../shared/types.ts'
import type { LayerEditorState } from './layerEditorState.ts'

// 윤곽 연결에 필요한 최소 점 수(시작·중간·끝)
export const MIN_CONNECT_POINTS = 3
// 교차 연결은 끝점 둘이면 된다. 중간점은 더 찍을 수 있다.
export const MIN_BRIDGE_POINTS = 2
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
    else if (n === 2) message.value = '윤곽 연결: 끝점 2개. [교차 연결]로 잇거나, 중간점을 더 찍으세요.'
    else message.value = `윤곽 연결: ${n}점 지정됨 — [교차 연결]은 끝점 사이를 잇고, Enter는 윤곽 전체를 바꿉니다.`
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

  // 찍은 끝점(과 중간점) 사이의 짧은 윤곽만 베지어로 바꾼다. 자동 매핑이 교차 끝점을 못 찾을 때 쓴다.
  function commitConnectBridge() {
    const target = guardUnlocked()
    if (!target) return
    if (connectPoints.value.length < MIN_BRIDGE_POINTS) {
      error.value = `교차 연결에는 끝점 둘 이상이 필요합니다.`
      return
    }
    const marks = connectPoints.value.map(([x, y]) => ({ x, y }))
    const idx = selectedStrokeIndex.value

    if (isContourLayer(target)) {
      const outline = target.paths[idx]
      if (!outline) return
      const path = spliceOutlineBridge(outline, marks)
      if (!path) {
        error.value = '윤곽에서 끝점 사이를 찾지 못했습니다. 끝점을 윤곽 가까이 찍어 주세요.'
        return
      }
      connectPoints.value = []
      const copy = target.paths.slice()
      copy[idx] = path
      updateTargetPaths(copy, `교차 끝점을 베지어로 연결했습니다. ${SAVE_HINT}`)
      return
    }

    const stroke = target.strokes[idx]
    if (!stroke?.outline_path) {
      error.value = '연결할 획 윤곽이 없습니다.'
      return
    }
    const path = spliceOutlineBridge(stroke.outline_path, marks)
    if (!path) {
      error.value = '윤곽에서 끝점 사이를 찾지 못했습니다. 끝점을 윤곽 가까이 찍어 주세요.'
      return
    }
    connectPoints.value = []
    editStroke(
      idx,
      (current) => ({ ...restrokeFromOutline(current, path), map_manual: 1 }),
      `${idx + 1}획 교차 끝점을 베지어로 연결했습니다. ${SAVE_HINT}`,
    )
  }

  return { cancelConnect, undoConnectPoint, applyConnectPoint, commitConnectOutline, commitConnectBridge }
}
