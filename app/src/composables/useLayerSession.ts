import { LAYER_ID } from '../../shared/constants.ts'
import type { Ref } from 'vue'
import type { CharacterDetail, EditorTool, LayerRecord } from '../../shared/types.ts'
import { cloneLayer, cloneStroke } from './layerClone.ts'
import type { LayerEditorState } from './layerEditorState.ts'

export function useLayerSession(
  state: LayerEditorState,
  message: Ref<string>,
  error: Ref<string>,
  stopPlayback: () => void,
) {
  const {
    selected,
    shown,
    reveal,
    layers,
    activeLayerId,
    activeTool,
    selectedStrokeIndex,
    selectedMedianPointIndex,
    knifePoints,
    connectPoints,
    dirtyIds,
    soloSnapshot,
    strokesLayer,
    activeLayer,
    editableLayer,
    isEditableLocked,
  } = state

  function syncFromDetail(detail: CharacterDetail) {
    layers.value = detail.layers.map(cloneLayer)
    dirtyIds.value = new Set()
    soloSnapshot.value = null
    knifePoints.value = []
    connectPoints.value = []
    selectedMedianPointIndex.value = null
    if (!layers.value.some((l) => l.id === activeLayerId.value)) {
      activeLayerId.value = LAYER_ID.strokes
    }
    const target = editableLayer.value
    const count = target?.kind === 'FONT' ? target.paths.length : (target?.strokes.length ?? 0)
    shown.value = detail.strokes.length
    reveal.value = 1
    selectedStrokeIndex.value = count > 0 ? Math.min(selectedStrokeIndex.value, count - 1) : 0
  }

  function markDirty(layerId: string) {
    const next = new Set(dirtyIds.value)
    next.add(layerId)
    dirtyIds.value = next
    // STROKES 레이어가 바뀌면 selected.strokes와 획수도 즉시 맞춰 준다.
    if (layerId === LAYER_ID.strokes && selected.value) {
      const sl = strokesLayer.value
      if (sl) selected.value = { ...selected.value, strokes: sl.strokes.map(cloneStroke) }
    }
  }

  function selectLayer(layerId: string) {
    activeLayerId.value = layerId
    knifePoints.value = []
    connectPoints.value = []
    selectedMedianPointIndex.value = null
    const picked = layers.value.find((l) => l.id === layerId)
    if (picked?.kind === 'MEDIANS') {
      activeTool.value = 'median'
    }
    const target = editableLayer.value
    const count = target?.kind === 'FONT' ? target.paths.length : (target?.strokes.length ?? 0)
    if (selectedStrokeIndex.value >= count) {
      selectedStrokeIndex.value = Math.max(0, count - 1)
    }
    if (target?.id === LAYER_ID.strokes && count > 0) {
      shown.value = Math.max(1, Math.min(count, shown.value || count))
    }
  }

  function selectTool(tool: EditorTool) {
    activeTool.value = tool
    knifePoints.value = []
    connectPoints.value = []
    selectedMedianPointIndex.value = null
    if (tool === 'connect') {
      message.value = '윤곽 연결: 시작점 → 중간점(여러 개) → 끝점을 클릭한 뒤 Enter로 연결하세요.'
    }
  }

  function selectStrokeItem(index: number) {
    stopPlayback()
    selectedStrokeIndex.value = index
    selectedMedianPointIndex.value = null
    if (editableLayer.value?.id === LAYER_ID.strokes) {
      shown.value = index + 1
      reveal.value = 1
    }
  }

  function guardUnlocked(): LayerRecord | null {
    const target = editableLayer.value
    if (!target) return null
    if (isEditableLocked.value) {
      const cur = activeLayer.value
      error.value = `'${cur?.name ?? target.name}' 레이어가 잠겨 있거나 숨겨져 있습니다. 우측 레이어 패널에서 잠금(🔒)을 해제하고 눈(👁)을 켜세요.`
      return null
    }
    error.value = ''
    return target
  }

  return {
    syncFromDetail,
    markDirty,
    selectLayer,
    selectTool,
    selectStrokeItem,
    guardUnlocked,
  }
}
