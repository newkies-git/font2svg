import { useLayerAppearance } from './useLayerAppearance.ts'
import { useLayerCommands } from './useLayerCommands.ts'
import { useLayerSession } from './useLayerSession.ts'
import { useStrokeEdit } from './useStrokeEdit.ts'
import { createLayerEditorState } from './layerEditorState.ts'
import type { StudioState } from './useStudioState.ts'

export function useLayerWorkspace(
  studio: StudioState,
  hooks: {
    onReloadList: () => Promise<void>
    stopPlayback: () => void
    confirmImport?: () => Promise<'replace' | 'append' | null | undefined>
  },
) {
  const { selected, shown, reveal, message, error, busy } = studio
  const { onReloadList, stopPlayback } = hooks
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
    confirmImport: hooks.confirmImport,
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
    selectedPathPoints: state.selectedPathPoints,
    knifePoints: state.knifePoints,
    knifeMode: state.knifeMode,
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
    autoFitToFont: edit.autoFitToFont,
    resetActiveEdits: session.resetActiveEdits,
    updateSinglePathInActive: edit.updateSinglePathInActive,
    canDeleteSelectedPathPoints: edit.canDeleteSelectedPathPoints,
    setPathPointSelection: edit.setPathPointSelection,
    togglePathPointSelection: edit.togglePathPointSelection,
    clearPathPointSelection: edit.clearPathPointSelection,
    nudgeSelectedPathPoints: edit.nudgeSelectedPathPoints,
    insertPathPointAtPos: edit.insertPathPointAtPos,
    insertPathPointFromSelection: edit.insertPathPointFromSelection,
    toggleSelectedPathCurve: edit.toggleSelectedPathCurve,
    simplifySelectedPathPoints: edit.simplifySelectedPathPoints,
    deletePathPointAt: edit.deletePathPointAt,
    deleteSelectedPathPoints: edit.deleteSelectedPathPoints,
    moveMedianVertex: edit.moveMedianVertex,
    addMedianVertex: edit.addMedianVertex,
    deleteMedianVertex: edit.deleteMedianVertex,
    cancelKnife: edit.cancelKnife,
    applyKnifePoint: edit.applyKnifePoint,
    cancelConnect: edit.cancelConnect,
    undoConnectPoint: edit.undoConnectPoint,
    applyConnectPoint: edit.applyConnectPoint,
    commitConnectOutline: edit.commitConnectOutline,
    commitConnectBridge: edit.commitConnectBridge,
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
