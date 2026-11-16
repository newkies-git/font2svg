import { isContourLayer } from '../../shared/layerKind.ts'
import { LAYER_ID } from '../../shared/constants.ts'
import type { Ref } from 'vue'
import { separatePath, separateStroke } from '../lib/strokeOps.ts'
import type { KnifeMode, LayerRecord, Pt, StrokeRecord } from '../../shared/types.ts'
import { cloneStroke } from './layerClone.ts'
import type { LayerEditorState } from './layerEditorState.ts'

const KNIFE_HINT = '끝점은 클릭, 꺾는 점은 Shift+클릭 (Esc 취소)'
const FAILURE: Record<KnifeMode, { contour: string; stroke: string }> = {
  cut: {
    contour: '윤곽 분할 불가: 선택한 윤곽 외곽선과 교차하도록 칼 점을 지정하세요.',
    stroke: '획 분할 불가: 선택된 획의 외곽선과 교차하도록 칼 점을 지정하세요.',
  },
  extract: {
    contour: '교차 분리 불가: 분리할 획의 중심을 지나도록 안내선 점을 지정하세요.',
    stroke: '교차 분리 불가: 분리할 획의 중심을 지나도록 안내선 점을 지정하세요.',
  },
}
const SAVE_HINT = '[레이어 저장]을 누르면 반영됩니다.'

// 칼 도구(자르기·교차 분리): 칼 점을 모으다가 끝점에서 선택한 윤곽·획을 나눈다.
// 칼 모드가 extract(교차 분리)면 점들은 칼이 아니라 분리할 획의 중심을 따르는 안내선이다.
export function useKnifeTool(
  state: LayerEditorState,
  message: Ref<string>,
  error: Ref<string>,
  guardUnlocked: () => LayerRecord | null,
  updateTargetStrokes: (strokes: StrokeRecord[], statusMsg?: string) => void,
  updateTargetPaths: (paths: string[], statusMsg?: string) => void,
) {
  const { shown, selectedStrokeIndex, knifePoints, knifeMode } = state

  function cancelKnife() {
    knifePoints.value = []
    message.value = '획 분할이 취소되었습니다.'
  }

  // 선택한 윤곽(궁서체·획 윤곽 레이어의 paths)을 나눠 그 자리에 끼운다.
  function splitContour(target: LayerRecord, knife: Pt[], mode: KnifeMode) {
    const index = selectedStrokeIndex.value
    const path = target.paths[index]
    if (!path) return
    const paths = separatePath(path, knife.map(([x, y]) => ({ x, y })), mode)
    if (!paths) {
      error.value = FAILURE[mode].contour
      return
    }
    const copy = target.paths.slice()
    copy.splice(index, 1, ...paths)
    updateTargetPaths(copy, `윤곽을 ${paths.length}개로 ${mode === 'extract' ? '나눴습니다(교차 분리)' : '분할했습니다'}. ${SAVE_HINT}`)
  }

  // 선택한 획을 나눠 그 자리에 끼우고, 나뉜 두 번째 획을 선택한다.
  function splitStroke(target: LayerRecord, knife: Pt[], mode: KnifeMode) {
    const index = selectedStrokeIndex.value
    const stroke = target.strokes[index]
    if (!stroke) return
    const parts = separateStroke(stroke, knife.map(([x, y]) => ({ x, y })), mode)
    if (!parts) {
      error.value = FAILURE[mode].stroke
      return
    }
    const pieces = parts.map((piece): StrokeRecord => ({
      ...piece,
      // 획 윤곽(OUTLINE) 레이어에서 나이프로 가른 조각은 사람이 만든 매핑이라 자동 매핑이 덮어쓰지 않는다.
      ...(target.kind === 'OUTLINE' ? { map_manual: 1 as const } : {}),
    }))
    const copy = target.strokes.map(cloneStroke)
    copy.splice(index, 1, ...pieces)
    const done = mode === 'extract'
      ? `${index + 1}획을 ${pieces.length}개로 나눴습니다(교차 분리). 교차부는 두 획이 함께 가집니다.`
      : `${index + 1}획을 ${pieces.length}개로 분할했습니다. 단면이 획의 끝이면 기필·수필 모양이 붙습니다.`
    updateTargetStrokes(copy, `${done} ${SAVE_HINT}`)
    selectedStrokeIndex.value = index + 1
    if (target.id === LAYER_ID.strokes) shown.value = index + pieces.length
  }

  // 칼 점을 더한다. 일반 클릭은 끝점이라 바로 가르고, extend(Shift+클릭)는 꺾는 점을 더하고 계속한다.
  function applyKnifePoint(point: Pt, extend = false) {
    const target = guardUnlocked()
    if (!target) return
    if (knifePoints.value.length === 0) {
      knifePoints.value = [point]
      message.value = `칼 분할: 다음 점을 클릭하세요. ${KNIFE_HINT}`
      return
    }
    if (extend) {
      knifePoints.value = [...knifePoints.value, point]
      message.value = `칼 분할: 점 ${knifePoints.value.length}개 — ${KNIFE_HINT}`
      return
    }
    const knife = [...knifePoints.value, point]
    knifePoints.value = []
    if (isContourLayer(target)) splitContour(target, knife, knifeMode.value)
    else splitStroke(target, knife, knifeMode.value)
  }

  return { cancelKnife, applyKnifePoint }
}
