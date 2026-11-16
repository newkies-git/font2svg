import type { Ref } from 'vue'
import { META_PATCH_DEBOUNCE_MS, OPACITY_STEPS } from '../lib/constants.ts'
import type { LayerColor, LayerMetaPatch, LayerRecord } from '../types.ts'
import type { LayerEditorState } from './layerEditorState.ts'

export function useLayerAppearance(
  state: LayerEditorState,
  message: Ref<string>,
  onAutoFetch: (layerId: string, keepActiveSelection: boolean) => void,
) {
  const { selected, layers, panelLayers, soloSnapshot } = state

  let metaTimer: ReturnType<typeof setTimeout> | null = null
  const pendingMeta = new Map<string, LayerMetaPatch>()

  function queueMetaPatch(patch: LayerMetaPatch) {
    const prev = pendingMeta.get(patch.id) ?? { id: patch.id }
    pendingMeta.set(patch.id, { ...prev, ...patch })
    if (metaTimer) clearTimeout(metaTimer)
    metaTimer = setTimeout(() => {
      flushMetaPatches()
    }, META_PATCH_DEBOUNCE_MS)
  }

  async function flushMetaPatches() {
    if (!selected.value || pendingMeta.size === 0) return
    const unicode = selected.value.unicode
    const patches = [...pendingMeta.values()]
    pendingMeta.clear()
    try {
      await fetch(`/api/characters/${encodeURIComponent(unicode)}/layers-meta`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patches }),
      })
    } catch {
      // 뷰 표시 메타 저장 실패는 편집 작업을 막지 않는다.
    }
  }

  function canAutoFetch(layer: LayerRecord): boolean {
    return !layer.available && (layer.kind === 'NAVER' || layer.kind === 'ACJK' || layer.kind === 'MMH')
  }

  function isSoloed(layerId: string): boolean {
    const target = layers.value.find((l) => l.id === layerId)
    if (!target || !target.visible) return false
    return !layers.value.some((l) => l.id !== layerId && l.visible)
  }

  function soloLayer(layerId: string) {
    const target = layers.value.find((l) => l.id === layerId)
    if (!target) return

    if (isSoloed(layerId) && soloSnapshot.value) {
      const snap = soloSnapshot.value
      soloSnapshot.value = null
      for (const l of layers.value) {
        const next = snap[l.id] ?? l.visible
        if (l.visible !== next) {
          l.visible = next
          queueMetaPatch({ id: l.id, visible: next })
        }
      }
      message.value = '이전 레이어 표시 상태로 복원했습니다.'
      return
    }

    const snap: Record<string, boolean> = {}
    for (const l of layers.value) {
      snap[l.id] = l.visible
      const next = l.id === layerId
      if (l.visible !== next) {
        l.visible = next
        queueMetaPatch({ id: l.id, visible: next })
      }
    }
    soloSnapshot.value = snap
    if (canAutoFetch(target)) {
      onAutoFetch(target.id, true)
    } else {
      message.value = `'${target.name}' 레이어만 단독 표시합니다. (다시 누르면 복원)`
    }
  }

  // PhotoCraft 눈 아이콘: 일반 클릭은 개별 표시/숨김 토글, Alt-클릭은 단독 보기(Solo) / 복원
  function toggleLayerVisible(layerId: string, altKey = false) {
    const target = layers.value.find((l) => l.id === layerId)
    if (!target) return

    if (altKey) {
      soloLayer(layerId)
      return
    }

    soloSnapshot.value = null
    const nextVisible = !target.visible
    if (nextVisible && canAutoFetch(target)) {
      onAutoFetch(target.id, true)
      return
    }
    target.visible = nextVisible
    queueMetaPatch({ id: target.id, visible: target.visible })
    message.value = target.visible ? `'${target.name}' 레이어를 표시합니다.` : `'${target.name}' 레이어를 숨겼습니다.`
  }

  function setPresetVisibility(preset: 'all' | 'work' | 'none') {
    soloSnapshot.value = null
    for (const l of layers.value) {
      let next = false
      if (preset === 'all') {
        next = l.available || l.kind === 'MEDIANS' || l.kind === 'NUMBERS' || l.kind === 'STROKES'
      } else if (preset === 'work') {
        next = l.kind === 'FONT' || l.kind === 'STROKES' || l.kind === 'MEDIANS' || l.kind === 'NUMBERS'
      } else {
        next = false
      }
      if (l.visible !== next) {
        l.visible = next
        queueMetaPatch({ id: l.id, visible: next })
      }
    }
    message.value =
      preset === 'all'
        ? '사용 가능한 모든 레이어를 표시합니다.'
        : preset === 'work'
          ? '기본 작업 레이어(궁서체·작업 획·중심선·획순 번호)만 표시합니다.'
          : '모든 레이어를 숨겼습니다. 보고 싶은 레이어를 켜세요.'
  }

  function setLayerVisibleDirect(layerId: string, visible: boolean) {
    const target = layers.value.find((l) => l.id === layerId)
    if (!target || target.visible === visible) return
    soloSnapshot.value = null
    target.visible = visible
    queueMetaPatch({ id: target.id, visible })
  }

  function setLayerOpacity(layerId: string, opacity: number) {
    const target = layers.value.find((l) => l.id === layerId)
    if (!target) return
    const clamped = Math.max(0, Math.min(1, Math.round(opacity * OPACITY_STEPS) / OPACITY_STEPS))
    target.opacity = clamped
    queueMetaPatch({ id: target.id, opacity: clamped })
  }

  function toggleLayerLock(layerId: string) {
    const target = layers.value.find((l) => l.id === layerId)
    if (!target) return
    target.locked = !target.locked
    queueMetaPatch({ id: target.id, locked: target.locked })
    message.value = target.locked ? `'${target.name}' 레이어를 잠갔습니다.` : `'${target.name}' 레이어 잠금을 해제했습니다.`
  }

  function setLayerColor(layerId: string, color: LayerColor) {
    const target = layers.value.find((l) => l.id === layerId)
    if (!target) return
    target.label_color = color
    queueMetaPatch({ id: target.id, label_color: color })
  }

  function renameLayer(layerId: string, name: string) {
    const trimmed = name.trim()
    const target = layers.value.find((l) => l.id === layerId)
    if (!target || !trimmed || target.name === trimmed) return
    target.name = trimmed
    queueMetaPatch({ id: target.id, name: trimmed })
  }

  // 패널(위→아래 역순)에서 순서 이동
  function moveLayerOrder(layerId: string, targetLayerId: string) {
    if (layerId === targetLayerId) return
    const panel = panelLayers.value.slice()
    const fromIdx = panel.findIndex((l) => l.id === layerId)
    const toIdx = panel.findIndex((l) => l.id === targetLayerId)
    if (fromIdx < 0 || toIdx < 0) return
    const [moved] = panel.splice(fromIdx, 1)
    panel.splice(toIdx, 0, moved)
    // panel[0]이 가장 높은 z_index를 갖도록 재부여
    const total = panel.length
    panel.forEach((layer, idx) => {
      const nextZ = total - 1 - idx
      if (layer.z_index !== nextZ) {
        layer.z_index = nextZ
        queueMetaPatch({ id: layer.id, z_index: nextZ })
      }
    })
  }

  return {
    flushMetaPatches,
    isSoloed,
    soloLayer,
    toggleLayerVisible,
    setPresetVisibility,
    setLayerVisibleDirect,
    setLayerOpacity,
    toggleLayerLock,
    setLayerColor,
    renameLayer,
    moveLayerOrder,
  }
}
