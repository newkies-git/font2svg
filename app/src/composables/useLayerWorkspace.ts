import type { Ref } from 'vue'
import { useLayerAppearance } from './useLayerAppearance.ts'
import { useLayerCommands } from './useLayerCommands.ts'
import { useLayerSession } from './useLayerSession.ts'
import { useStrokeEdit } from './useStrokeEdit.ts'
import { createLayerEditorState } from './layerEditorState.ts'
import type { CharacterDetail } from '../types.ts'

export function useLayerWorkspace(
  selected: Ref<CharacterDetail | null>,
  shown: Ref<number>,
  reveal: Ref<number>,
  message: Ref<string>,
  error: Ref<string>,
  busy: Ref<boolean>,
  onReloadList: () => Promise<void>,
  stopPlayback: () => void,
) {
  const state = createLayerEditorState(selected, shown, reveal)
  const session = useLayerSession(state, message, error, stopPlayback)
  let fetchReference: (layerId: string, keepActiveSelection?: boolean) => void = () => {}
  const appearance = useLayerAppearance(state, message, (layerId, keep) => {
    fetchReference(layerId, keep)
  })
  const edit = useStrokeEdit(state, message, error, session.guardUnlocked, session.markDirty)
  const commands = useLayerCommands(state, {
    message,
    error,
    busy,
    onReloadList,
    flushMetaPatches: appearance.flushMetaPatches,
    syncFromDetail: session.syncFromDetail,
    markDirty: session.markDirty,
    guardUnlocked: session.guardUnlocked,
    updateTargetStrokes: edit.updateTargetStrokes,
  })
  fetchReference = (layerId, keep) => {
    void commands.fetchReferenceForLayer(layerId, keep)
  }

  return {
    layers: state.layers,
    panelLayers: state.panelLayers,
    orderedLayers: state.orderedLayers,
    strokesLayer: state.strokesLayer,
    mediansLayer: state.mediansLayer,
    numbersLayer: state.numbersLayer,
    fontLayer: state.fontLayer,
    activeLayerId: state.activeLayerId,
    activeLayer: state.activeLayer,
    editableLayer: state.editableLayer,
    isEditableLocked: state.isEditableLocked,
    activeStrokes: state.activeStrokes,
    activeTool: state.activeTool,
    transformScope: state.transformScope,
    transformMode: state.transformMode,
    selectedStrokeIndex: state.selectedStrokeIndex,
    selectedMedianPointIndex: state.selectedMedianPointIndex,
    knifeFrom: state.knifeFrom,
    connectPoints: state.connectPoints,
    dirtyIds: state.dirtyIds,
    syncFromDetail: session.syncFromDetail,
    selectLayer: session.selectLayer,
    selectTool: session.selectTool,
    selectStrokeItem: session.selectStrokeItem,
    toggleLayerVisible: appearance.toggleLayerVisible,
    soloLayer: appearance.soloLayer,
    isSoloed: appearance.isSoloed,
    setPresetVisibility: appearance.setPresetVisibility,
    setLayerVisibleDirect: appearance.setLayerVisibleDirect,
    setLayerOpacity: appearance.setLayerOpacity,
    toggleLayerLock: appearance.toggleLayerLock,
    setLayerColor: appearance.setLayerColor,
    renameLayer: appearance.renameLayer,
    moveLayerOrder: appearance.moveLayerOrder,
    moveStrokeInActive: edit.moveStrokeInActive,
    setStrokeRadical: edit.setStrokeRadical,
    setStrokeCap: edit.setStrokeCap,
    reverseActiveStrokeMedian: edit.reverseActiveStrokeMedian,
    deleteStrokeAt: edit.deleteStrokeAt,
    mergeStrokeWithNext: edit.mergeStrokeWithNext,
    copyStrokeToWorkLayer: edit.copyStrokeToWorkLayer,
    restoreActiveSnapshot: edit.restoreActiveSnapshot,
    applyAffineToActive: edit.applyAffineToActive,
    alignActiveToFont: edit.alignActiveToFont,
    autoFitToFont: edit.autoFitToFont,
    updateSinglePathInActive: edit.updateSinglePathInActive,
    moveMedianVertex: edit.moveMedianVertex,
    addMedianVertex: edit.addMedianVertex,
    deleteMedianVertex: edit.deleteMedianVertex,
    cancelKnife: edit.cancelKnife,
    applyKnifePoint: edit.applyKnifePoint,
    cancelConnect: edit.cancelConnect,
    undoConnectPoint: edit.undoConnectPoint,
    applyConnectPoint: edit.applyConnectPoint,
    commitConnectOutline: edit.commitConnectOutline,
    saveActiveLayer: commands.saveActiveLayer,
    saveAllDirtyLayers: commands.saveAllDirtyLayers,
    resetLayerToOriginal: commands.resetLayerToOriginal,
    fetchReferenceForLayer: commands.fetchReferenceForLayer,
    applyLayerToWorkStrokes: commands.applyLayerToWorkStrokes,
    resegmentActiveByFont: commands.resegmentActiveByFont,
    generateOutlineLayer: commands.generateOutlineLayer,
    mapOutlineContours: commands.mapOutlineContours,
    refreshOutlineMapping: commands.refreshOutlineMapping,
    duplicateActiveLayer: commands.duplicateActiveLayer,
    deleteActiveCustomLayer: commands.deleteActiveCustomLayer,
  }
}
