import { LAYER_ID } from '../../shared/constants.ts'
import { isContourLayer, isReferenceKind } from '../../shared/layerKind.ts'
import { ref, type Ref } from 'vue'
import type { CharacterDetail, EditorTool, LayerRecord } from '../../shared/types.ts'
import { pruneHiddenIndices } from '../lib/hiddenItems.ts'
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
    selectedPathPoints,
    knifePoints,
    connectPoints,
    dirtyIds,
    soloSnapshot,
    hiddenItemsByLayer,
    strokesLayer,
    activeLayer,
    editableLayer,
    isEditableLocked,
  } = state

  // 서버에서 받은 직후(또는 저장 직후) 레이어 스냅샷. 초기화 버튼이 여기로 되돌린다.
  const baselines = ref(new Map<string, LayerRecord>())
  let syncedUnicode: string | null = null

  function syncFromDetail(detail: CharacterDetail) {
    const cloned = detail.layers.map(cloneLayer)
    layers.value = cloned
    baselines.value = new Map(cloned.map((layer) => [layer.id, cloneLayer(layer)]))
    dirtyIds.value = new Set()
    soloSnapshot.value = null
    if (syncedUnicode !== detail.unicode) {
      hiddenItemsByLayer.value = {}
      syncedUnicode = detail.unicode
    } else {
      const nextHidden: Record<string, Set<number>> = {}
      for (const layer of cloned) {
        const cur = hiddenItemsByLayer.value[layer.id]
        if (!cur || cur.size === 0) continue
        const count = isContourLayer(layer) ? layer.paths.length : layer.strokes.length
        const pruned = pruneHiddenIndices(cur, count)
        if (pruned.size > 0) nextHidden[layer.id] = pruned
      }
      hiddenItemsByLayer.value = nextHidden
    }
    knifePoints.value = []
    connectPoints.value = []
    selectedMedianPointIndex.value = null
    selectedPathPoints.value = new Set()
    if (!layers.value.some((l) => l.id === activeLayerId.value)) {
      activeLayerId.value = LAYER_ID.strokes
    }
    const target = editableLayer.value
    const count = target?.kind === 'FONT' ? target.paths.length : (target?.strokes.length ?? 0)
    shown.value = detail.strokes.length
    reveal.value = 1
    selectedStrokeIndex.value = count > 0 ? Math.min(selectedStrokeIndex.value, count - 1) : 0
  }

  // 편집 중인 레이어를 마지막 동기화 상태로 되돌린다(미저장 맞춤·이동 등 취소). 궁서체 기준 레이어는 대상이 아니다.
  function resetActiveEdits() {
    const target = guardUnlocked()
    if (!target) return
    if (target.kind === 'FONT' || target.id === LAYER_ID.font) {
      error.value = '궁서체(TTF)는 기준 레이어라 초기화하지 않습니다.'
      return
    }
    if (!dirtyIds.value.has(target.id)) {
      message.value = '되돌릴 변경이 없습니다.'
      return
    }
    const baseline = baselines.value.get(target.id)
    if (!baseline) {
      error.value = '초기화할 기준 상태가 없습니다. 글자를 다시 선택하세요.'
      return
    }
    const index = layers.value.findIndex((layer) => layer.id === target.id)
    if (index < 0) return
    const restored = cloneLayer(baseline)
    layers.value = layers.value.map((layer, i) => (i === index ? restored : layer))
    const next = new Set(dirtyIds.value)
    next.delete(target.id)
    dirtyIds.value = next
    if (target.id === LAYER_ID.strokes && selected.value) {
      selected.value = { ...selected.value, strokes: restored.strokes.map(cloneStroke) }
      shown.value = Math.max(1, Math.min(restored.strokes.length, shown.value || restored.strokes.length))
    }
    const count = restored.kind === 'FONT' ? restored.paths.length : restored.strokes.length
    if (selectedStrokeIndex.value >= count) selectedStrokeIndex.value = Math.max(0, count - 1)
    selectedPathPoints.value = new Set()
    if (target.id in hiddenItemsByLayer.value) {
      const rest = { ...hiddenItemsByLayer.value }
      delete rest[target.id]
      hiddenItemsByLayer.value = rest
    }
    message.value = `'${restored.name}' 레이어를 불러온 상태로 초기화했습니다.`
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
    selectedPathPoints.value = new Set()
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
    selectedPathPoints.value = new Set()
    if (tool === 'connect') {
      message.value = '윤곽 연결: 시작점 → 중간점(여러 개) → 끝점을 클릭한 뒤 Enter로 연결하세요.'
    } else if (tool === 'bezier') {
      message.value = '정점 편집: 점을 드래그하거나 영역을 드래그해 여러 점을 함께 옮기세요. 윤곽선 더블클릭으로 정점 추가, Delete·Alt+클릭으로 삭제합니다.'
    }
  }

  function selectStrokeItem(index: number) {
    stopPlayback()
    selectedStrokeIndex.value = index
    selectedMedianPointIndex.value = null
    selectedPathPoints.value = new Set()
    if (editableLayer.value?.id === LAYER_ID.strokes) {
      shown.value = index + 1
      reveal.value = 1
    }
  }

  function guardUnlocked(): LayerRecord | null {
    const target = editableLayer.value
    if (!target) return null
    if (isReferenceKind(target.kind)) {
      error.value = `'${target.name}' 레이어는 참고용입니다. 작업 획으로 가져온 뒤 편집하세요.`
      return null
    }
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
    resetActiveEdits,
    markDirty,
    selectLayer,
    selectTool,
    selectStrokeItem,
    guardUnlocked,
  }
}
