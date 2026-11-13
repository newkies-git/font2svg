import type { Ref } from 'vue'
import type { CharacterDetail, LayerRecord, Pt, StrokeRecord } from '../types.ts'
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

  async function saveActiveLayer(customAction?: string) {
    const target = editableLayer.value
    if (!selected.value || !target) return
    await flushMetaPatches()
    busy.value = true
    error.value = ''
    try {
      const payload = target.kind === 'FONT' && target.strokes.length === 0
        ? { paths: target.paths, action: customAction ?? `${target.name} 편집` }
        : { strokes: target.strokes, paths: target.paths.length ? target.paths : undefined, action: customAction ?? `${target.name} 편집` }
      const response = await fetch(
        `/api/characters/${encodeURIComponent(selected.value.unicode)}/layers/${encodeURIComponent(target.id)}/save`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? '레이어 저장에 실패했습니다.')
      selected.value = body as CharacterDetail
      syncFromDetail(body as CharacterDetail)
      message.value = `'${target.name}' 레이어 저장 완료`
      await onReloadList()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '레이어 저장 중 오류가 발생했습니다.'
    } finally {
      busy.value = false
    }
  }

  async function saveAllDirtyLayers() {
    if (!selected.value) return
    const ids = [...dirtyIds.value]
    if (ids.length === 0) {
      await saveActiveLayer()
      return
    }
    await flushMetaPatches()
    busy.value = true
    error.value = ''
    try {
      let latest: CharacterDetail | null = null
      for (const id of ids) {
        const layer = layers.value.find((l) => l.id === id)
        if (!layer) continue
        const payload = layer.kind === 'FONT' && layer.strokes.length === 0
          ? { paths: layer.paths, action: `${layer.name} 편집` }
          : { strokes: layer.strokes, paths: layer.paths.length ? layer.paths : undefined, action: `${layer.name} 편집` }
        const response = await fetch(
          `/api/characters/${encodeURIComponent(selected.value.unicode)}/layers/${encodeURIComponent(id)}/save`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          },
        )
        const body = await response.json()
        if (!response.ok) throw new Error(body.error ?? `'${layer.name}' 저장 실패`)
        latest = body as CharacterDetail
      }
      if (latest) {
        selected.value = latest
        syncFromDetail(latest)
      }
      message.value = `변경된 레이어 ${ids.length}개를 모두 저장했습니다.`
      await onReloadList()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '레이어 저장 중 오류가 발생했습니다.'
    } finally {
      busy.value = false
    }
  }

  async function resetLayerToOriginal(layerId = editableLayer.value?.id) {
    if (!selected.value || !layerId) return
    await flushMetaPatches()
    busy.value = true
    error.value = ''
    try {
      const response = await fetch(
        `/api/characters/${encodeURIComponent(selected.value.unicode)}/layers/${encodeURIComponent(layerId)}/reset`,
        { method: 'POST' },
      )
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? '원본 복원에 실패했습니다.')
      selected.value = body as CharacterDetail
      syncFromDetail(body as CharacterDetail)
      message.value = '레이어를 원본 데이터로 복원했습니다.'
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '원본 복원 중 오류가 발생했습니다.'
    } finally {
      busy.value = false
    }
  }

  async function fetchReferenceForLayer(layerId: string, keepActiveSelection = false) {
    if (!selected.value) return
    await flushMetaPatches()
    busy.value = true
    error.value = ''
    const prevDirty = new Map<string, LayerRecord>()
    for (const id of dirtyIds.value) {
      const found = layers.value.find((l) => l.id === id)
      if (found) prevDirty.set(id, cloneLayer(found))
    }
    try {
      const response = await fetch(
        `/api/characters/${encodeURIComponent(selected.value.unicode)}/layers/${encodeURIComponent(layerId)}/fetch`,
        { method: 'POST' },
      )
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? '레퍼런스 수신에 실패했습니다.')
      const detail = body as CharacterDetail
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
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '레퍼런스 수신 실패: 네트워크 상태를 확인하세요.'
    } finally {
      busy.value = false
    }
  }

  async function applyLayerToWorkStrokes(layerId: string, mode: 'direct' | 'fit_font') {
    if (!selected.value) return
    // 먼저 해당 레이어가 수정 중이면 서버에 반영 후 적용
    if (dirtyIds.value.has(layerId)) {
      await saveAllDirtyLayers()
      if (error.value) return
    } else {
      await flushMetaPatches()
    }
    busy.value = true
    error.value = ''
    try {
      const response = await fetch(
        `/api/characters/${encodeURIComponent(selected.value.unicode)}/layers/${encodeURIComponent(layerId)}/apply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode }),
        },
      )
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? '작업 획 적용에 실패했습니다.')
      selected.value = body as CharacterDetail
      syncFromDetail(body as CharacterDetail)
      activeLayerId.value = 'strokes'
      message.value = mode === 'fit_font'
        ? '선택 레이어의 중심선으로 궁서체 윤곽을 분할해 작업 획에 적용했습니다.'
        : '선택 레이어의 획 데이터를 작업 획에 적용했습니다.'
      await onReloadList()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '작업 획 적용 중 오류가 발생했습니다.'
    } finally {
      busy.value = false
    }
  }

  async function resegmentActiveByFont() {
    const target = guardUnlocked()
    if (!selected.value || !target || target.strokes.length === 0) return
    busy.value = true
    error.value = ''
    try {
      const response = await fetch(`/api/characters/${encodeURIComponent(selected.value.unicode)}/resegment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ medians: target.strokes.map((s) => s.median_points) }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? '윤곽 재분할에 실패했습니다.')
      const { outlines, medians, widths } = body as { outlines: string[]; medians: Pt[][]; widths: number[] }
      const next = target.strokes.map((stroke, idx): StrokeRecord => ({
        ...stroke,
        stroke_order: idx + 1,
        outline_path: outlines[idx],
        median_points: medians[idx],
        stroke_width: widths[idx],
      }))
      updateTargetStrokes(next, `'${target.name}' 중심선 기준으로 궁서체 윤곽을 재분할했습니다. 확인 후 저장하세요.`)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '윤곽 재분할 중 오류가 발생했습니다.'
    } finally {
      busy.value = false
    }
  }

  async function duplicateActiveLayer() {
    if (!selected.value) return
    const src = editableLayer.value ?? activeLayer.value
    await flushMetaPatches()
    busy.value = true
    error.value = ''
    try {
      const response = await fetch(`/api/characters/${encodeURIComponent(selected.value.unicode)}/layers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceLayerId: src?.id }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? '레이어 복제에 실패했습니다.')
      const { createdId, detail } = body as { createdId: string; detail: CharacterDetail }
      selected.value = detail
      syncFromDetail(detail)
      activeLayerId.value = createdId
      message.value = `'${src?.name ?? '새'}' 레이어를 복제했습니다.`
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '레이어 복제 중 오류가 발생했습니다.'
    } finally {
      busy.value = false
    }
  }

  async function deleteActiveCustomLayer() {
    const cur = activeLayer.value
    if (!selected.value || !cur || cur.kind !== 'CUSTOM') return
    await flushMetaPatches()
    busy.value = true
    error.value = ''
    try {
      const response = await fetch(
        `/api/characters/${encodeURIComponent(selected.value.unicode)}/layers/${encodeURIComponent(cur.id)}`,
        { method: 'DELETE' },
      )
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? '레이어 삭제에 실패했습니다.')
      selected.value = body as CharacterDetail
      activeLayerId.value = 'strokes'
      syncFromDetail(body as CharacterDetail)
      message.value = `'${cur.name}' 레이어를 삭제했습니다.`
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '레이어 삭제 중 오류가 발생했습니다.'
    } finally {
      busy.value = false
    }
  }

  return {
    saveActiveLayer,
    saveAllDirtyLayers,
    resetLayerToOriginal,
    fetchReferenceForLayer,
    applyLayerToWorkStrokes,
    resegmentActiveByFont,
    duplicateActiveLayer,
    deleteActiveCustomLayer,
  }
}
