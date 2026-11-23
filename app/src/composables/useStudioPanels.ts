import { computed } from 'vue'
import { LAYER_ID } from '../../shared/constants.ts'
import type { CapType } from '../../shared/types.ts'
import type { useLayerWorkspace } from './useLayerWorkspace.ts'

type LayerWorkspace = ReturnType<typeof useLayerWorkspace>
type PanelDeps = Pick<
  LayerWorkspace,
  'layers' | 'editableLayer' | 'activeLayer' | 'selectedStrokeIndex' | 'setStrokeCap' | 'selectTool' | 'toggleLayerLock' | 'toggleLayerVisible'
>

// 상단 바·획 목록 같은 패널이 쓰는 파생 상태와 묶음 동작. 작업 공간의 상태를 읽고 동작을 호출만 하며 자기 상태는 두지 않는다.
export function useStudioPanels(workspace: PanelDeps) {
  const { layers, editableLayer, activeLayer, selectedStrokeIndex } = workspace

  // 획 윤곽 자동 매핑에서 중심선 길잡이로 쓸 수 있는 레이어(획이 있는 레이어, 작업 획 우선)
  const outlineGuideLayers = computed(() => layers.value
    .filter((l) => l.id !== LAYER_ID.outline && l.strokes.length > 0)
    .sort((a, b) => Number(b.id === LAYER_ID.strokes) - Number(a.id === LAYER_ID.strokes) || a.z_index - b.z_index))

  const canEditPathPoints = computed(() => {
    const ed = editableLayer.value
    if (!ed) return false
    return Boolean(ed.kind === 'FONT' ? ed.paths[selectedStrokeIndex.value] : ed.strokes[selectedStrokeIndex.value]?.outline_path)
  })

  // 기필/수필을 '직접 그리기'로 고르면 꼭짓점(베지어) 편집 도구로 넘어가 그 끝의 윤곽을 손으로 고친다.
  function onSetCap(index: number, end: 'start' | 'end', value: CapType) {
    workspace.setStrokeCap(index, end, value)
    if (value === 'MANUAL') workspace.selectTool('bezier')
  }

  // 편집하려는 레이어가 잠겨 있거나 숨겨져 있으면 풀고 보이게 한다.
  function unlockActiveLayers() {
    if (activeLayer.value?.locked) workspace.toggleLayerLock(activeLayer.value.id)
    if (editableLayer.value?.locked && editableLayer.value.id !== activeLayer.value?.id) {
      workspace.toggleLayerLock(editableLayer.value.id)
    }
    if (activeLayer.value && !activeLayer.value.visible) workspace.toggleLayerVisible(activeLayer.value.id, false)
    if (editableLayer.value && !editableLayer.value.visible) workspace.toggleLayerVisible(editableLayer.value.id, false)
  }

  return { outlineGuideLayers, canEditPathPoints, onSetCap, unlockActiveLayers }
}
