import { LAYER_ID } from '../lib/constants.ts'
import type { Ref } from 'vue'
import { apiRequest, characterUrl } from '../lib/api.ts'
import { isContourLayer } from '../lib/layerKind.ts'
import type { CharacterDetail, LayerRecord, Pt, StrokeRecord } from '../types.ts'
import { createBusyRunner } from './useBusyAction.ts'
import { cloneLayer } from './layerClone.ts'
import type { LayerEditorState } from './layerEditorState.ts'

type LayerCommandsDeps = {
  message: Ref<string>
  error: Ref<string>
  busy: Ref<boolean>
  onReloadList: () => Promise<void>
  flushMetaPatches: () => Promise<void>
  syncFromDetail: (detail: CharacterDetail) => void
  markDirty: (layerId: string) => void
  guardUnlocked: () => LayerRecord | null
  updateTargetStrokes: (nextStrokes: StrokeRecord[], statusMsg?: string) => void
}

// 서버에 저장할 레이어 내용: 윤곽만 있는 궁서체 레이어는 paths만, 나머지는 획과 paths를 보낸다.
function layerSavePayload(layer: LayerRecord, action: string) {
  return isContourLayer(layer)
    ? { paths: layer.paths, action }
    : { strokes: layer.strokes, paths: layer.paths.length ? layer.paths : undefined, action }
}

export function useLayerCommands(state: LayerEditorState, deps: LayerCommandsDeps) {
  const { selected, layers, activeLayerId, activeLayer, editableLayer, dirtyIds, soloSnapshot } = state
  const {
    message,
    error,
    busy,
    onReloadList,
    flushMetaPatches,
    syncFromDetail,
    markDirty,
    guardUnlocked,
    updateTargetStrokes,
  } = deps
  const run = createBusyRunner(busy, error)

  // 서버가 돌려준 글자 상세를 화면 상태에 반영한다.
  function adopt(detail: CharacterDetail) {
    selected.value = detail
    syncFromDetail(detail)
  }

  // 레이어 id가 dirty면 서버에 먼저 저장하고, 아니면 보류 중인 표시 메타만 비운다. 저장 중 오류가 나면 false.
  async function prepareLayerForServer(layerId: string): Promise<boolean> {
    if (dirtyIds.value.has(layerId)) {
      await saveAllDirtyLayers()
      return !error.value
    }
    await flushMetaPatches()
    return true
  }

  async function saveActiveLayer(customAction?: string) {
    const target = editableLayer.value
    const current = selected.value
    if (!current || !target) return
    await flushMetaPatches()
    await run(async () => {
      const detail = await apiRequest<CharacterDetail>(
        characterUrl(current.unicode, 'layers', target.id, 'save'),
        '레이어 저장에 실패했습니다.',
        { method: 'POST', body: layerSavePayload(target, customAction ?? `${target.name} 편집`) },
      )
      adopt(detail)
      message.value = `'${target.name}' 레이어 저장 완료`
      await onReloadList()
    }, '레이어 저장 중 오류가 발생했습니다.')
  }

  async function saveAllDirtyLayers() {
    const current = selected.value
    if (!current) return
    const ids = [...dirtyIds.value]
    if (ids.length === 0) {
      await saveActiveLayer()
      return
    }
    await flushMetaPatches()
    await run(async () => {
      let latest: CharacterDetail | null = null
      for (const id of ids) {
        const layer = layers.value.find((l) => l.id === id)
        if (!layer) continue
        latest = await apiRequest<CharacterDetail>(
          characterUrl(current.unicode, 'layers', id, 'save'),
          `'${layer.name}' 저장 실패`,
          { method: 'POST', body: layerSavePayload(layer, `${layer.name} 편집`) },
        )
      }
      if (latest) adopt(latest)
      message.value = `변경된 레이어 ${ids.length}개를 모두 저장했습니다.`
      await onReloadList()
    }, '레이어 저장 중 오류가 발생했습니다.')
  }

  async function resetLayerToOriginal(layerId = editableLayer.value?.id) {
    const current = selected.value
    if (!current || !layerId) return
    await flushMetaPatches()
    await run(async () => {
      adopt(await apiRequest<CharacterDetail>(
        characterUrl(current.unicode, 'layers', layerId, 'reset'),
        '원본 복원에 실패했습니다.',
        { method: 'POST' },
      ))
      message.value = '레이어를 원본 데이터로 복원했습니다.'
    }, '원본 복원 중 오류가 발생했습니다.')
  }

  async function fetchReferenceForLayer(layerId: string, keepActiveSelection = false) {
    const current = selected.value
    if (!current) return
    await flushMetaPatches()
    const prevDirty = new Map<string, LayerRecord>()
    for (const id of dirtyIds.value) {
      const found = layers.value.find((l) => l.id === id)
      if (found) prevDirty.set(id, cloneLayer(found))
    }
    await run(async () => {
      const detail = await apiRequest<CharacterDetail>(
        characterUrl(current.unicode, 'layers', layerId, 'fetch'),
        '레퍼런스 수신에 실패했습니다.',
        { method: 'POST' },
      )
      selected.value = detail
      const prevActive = activeLayerId.value
      const prevSolo = soloSnapshot.value
      syncFromDetail(detail)
      // 미저장 편집 중이던 다른 레이어의 인메모리 도형은 그대로 유지한다.
      for (const [id, snap] of prevDirty.entries()) {
        if (id === layerId) continue
        const target = layers.value.find((l) => l.id === id)
        if (target) {
          target.strokes = snap.strokes
          target.paths = snap.paths
          markDirty(id)
        }
      }
      soloSnapshot.value = prevSolo
      activeLayerId.value = keepActiveSelection ? prevActive : layerId
      message.value = `'${layers.value.find((l) => l.id === layerId)?.name ?? layerId}' 레이어를 수신해 표시했습니다.`
    }, '레퍼런스 수신 실패: 네트워크 상태를 확인하세요.')
  }

  async function applyLayerToWorkStrokes(layerId: string, mode: 'direct' | 'fit_font') {
    const current = selected.value
    if (!current) return
    // 먼저 해당 레이어가 수정 중이면 서버에 반영 후 적용
    if (!(await prepareLayerForServer(layerId))) return
    await run(async () => {
      adopt(await apiRequest<CharacterDetail>(
        characterUrl(current.unicode, 'layers', layerId, 'apply'),
        '작업 획 적용에 실패했습니다.',
        { method: 'POST', body: { mode } },
      ))
      activeLayerId.value = LAYER_ID.strokes
      message.value = mode === 'fit_font'
        ? '선택 레이어의 중심선으로 궁서체 윤곽을 분할해 작업 획에 적용했습니다.'
        : '선택 레이어의 획 데이터를 작업 획에 적용했습니다.'
      await onReloadList()
    }, '작업 획 적용 중 오류가 발생했습니다.')
  }

  async function resegmentActiveByFont() {
    const target = guardUnlocked()
    const current = selected.value
    if (!current || !target || target.strokes.length === 0) return
    await run(async () => {
      const { outlines, medians, widths } = await apiRequest<{ outlines: string[]; medians: Pt[][]; widths: number[] }>(
        characterUrl(current.unicode, 'resegment'),
        '윤곽 재분할에 실패했습니다.',
        { method: 'POST', body: { medians: target.strokes.map((s) => s.median_points) } },
      )
      const next = target.strokes.map((stroke, idx): StrokeRecord => ({
        ...stroke,
        stroke_order: idx + 1,
        outline_path: outlines[idx],
        median_points: medians[idx],
        stroke_width: widths[idx],
      }))
      updateTargetStrokes(next, `'${target.name}' 중심선 기준으로 궁서체 윤곽을 재분할했습니다. 확인 후 저장하세요.`)
    }, '윤곽 재분할 중 오류가 발생했습니다.')
  }

  // 획 윤곽(OUTLINE) 레이어 서버 작업. 미저장 편집이 있으면 먼저 저장해 서버 결과가 덮어쓰지 않게 한다.
  async function postOutline(action: 'generate' | 'map' | 'refresh', payload: Record<string, unknown>, doneMessage: string, failMessage: string) {
    const current = selected.value
    if (!current) return
    if (!(await prepareLayerForServer(LAYER_ID.outline))) return
    await run(async () => {
      adopt(await apiRequest<CharacterDetail>(
        characterUrl(current.unicode, 'outline', action),
        failMessage,
        { method: 'POST', body: payload },
      ))
      activeLayerId.value = LAYER_ID.outline
      message.value = doneMessage
    }, failMessage)
  }

  function generateOutlineLayer(sourceLayerId?: string) {
    return postOutline(
      'generate',
      { sourceLayerId },
      '궁서체 윤곽을 획별로 나눠 자동 매핑했습니다. 미매핑 획은 직접 매핑하세요.',
      '자동 매핑에 실패했습니다.',
    )
  }

  function mapOutlineContours(strokeIndex: number, contours: number[]) {
    return postOutline(
      'map',
      { strokeIndex, contours },
      contours.length === 0 ? `${strokeIndex + 1}획 매핑을 해제했습니다.` : `${strokeIndex + 1}획을 궁서체 윤곽 ${contours.map((i) => i + 1).join(', ')}번에 매핑했습니다.`,
      '윤곽 매핑에 실패했습니다.',
    )
  }

  function refreshOutlineMapping() {
    return postOutline(
      'refresh',
      {},
      '궁서체 윤곽 기준으로 매핑을 갱신했습니다. 어긋난 획이 없는지 확인하세요.',
      '매핑 갱신에 실패했습니다.',
    )
  }

  async function duplicateActiveLayer() {
    const current = selected.value
    if (!current) return
    const src = editableLayer.value ?? activeLayer.value
    await flushMetaPatches()
    await run(async () => {
      const { createdId, detail } = await apiRequest<{ createdId: string; detail: CharacterDetail }>(
        characterUrl(current.unicode, 'layers'),
        '레이어 복제에 실패했습니다.',
        { method: 'POST', body: { sourceLayerId: src?.id } },
      )
      adopt(detail)
      activeLayerId.value = createdId
      message.value = `'${src?.name ?? '새'}' 레이어를 복제했습니다.`
    }, '레이어 복제 중 오류가 발생했습니다.')
  }

  async function deleteActiveCustomLayer() {
    const cur = activeLayer.value
    const current = selected.value
    if (!current || !cur || cur.kind !== 'CUSTOM') return
    await flushMetaPatches()
    await run(async () => {
      const detail = await apiRequest<CharacterDetail>(
        characterUrl(current.unicode, 'layers', cur.id),
        '레이어 삭제에 실패했습니다.',
        { method: 'DELETE' },
      )
      selected.value = detail
      activeLayerId.value = LAYER_ID.strokes
      syncFromDetail(detail)
      message.value = `'${cur.name}' 레이어를 삭제했습니다.`
    }, '레이어 삭제 중 오류가 발생했습니다.')
  }

  return {
    saveActiveLayer,
    saveAllDirtyLayers,
    resetLayerToOriginal,
    fetchReferenceForLayer,
    applyLayerToWorkStrokes,
    resegmentActiveByFont,
    generateOutlineLayer,
    mapOutlineContours,
    refreshOutlineMapping,
    duplicateActiveLayer,
    deleteActiveCustomLayer,
  }
}
