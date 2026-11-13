import { computed, ref, type Ref } from 'vue'
import { recoverMedian, splitStrokeByKnife } from '../lib/strokeCut.ts'
import {
  insertMedianPoint,
  mergeTwoStrokes,
  pathsBBox,
  recomputeStrokeWidth,
  removeMedianPoint,
  reverseMedian,
  strokesBBox,
  transformPath,
  transformStroke,
} from '../lib/vectorEdit.ts'
import type {
  CapType,
  CharacterDetail,
  EditorTool,
  LayerColor,
  LayerMetaPatch,
  LayerRecord,
  Pt,
  StrokeRecord,
} from '../types.ts'

function cloneStroke(s: StrokeRecord): StrokeRecord {
  return {
    ...s,
    median_points: s.median_points.map((p): Pt => [p[0], p[1]]),
  }
}

function cloneLayer(layer: LayerRecord): LayerRecord {
  return {
    ...layer,
    strokes: layer.strokes.map(cloneStroke),
    paths: layer.paths.slice(),
  }
}

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
  const layers = ref<LayerRecord[]>([])
  const activeLayerId = ref<string>('strokes')
  const activeTool = ref<EditorTool>('select')
  const transformScope = ref<'layer' | 'stroke'>('layer')
  const selectedStrokeIndex = ref<number>(0)
  const selectedMedianPointIndex = ref<number | null>(null)
  const knifeFrom = ref<Pt | null>(null)
  const connectPoints = ref<Pt[]>([])
  const dirtyIds = ref<Set<string>>(new Set())
  const soloSnapshot = ref<Record<string, boolean> | null>(null)

  let metaTimer: ReturnType<typeof setTimeout> | null = null
  const pendingMeta = new Map<string, LayerMetaPatch>()

  // 역순 표시용(PhotoCraft 패널: 위쪽 행이 가장 위 레이어)
  const panelLayers = computed(() => layers.value.slice().sort((a, b) => b.z_index - a.z_index))

  // 합성 렌더링용(아래→위)
  const orderedLayers = computed(() => layers.value.slice().sort((a, b) => a.z_index - b.z_index))

  const strokesLayer = computed(() => layers.value.find((l) => l.id === 'strokes') ?? null)
  const mediansLayer = computed(() => layers.value.find((l) => l.id === 'medians') ?? null)
  const numbersLayer = computed(() => layers.value.find((l) => l.id === 'numbers') ?? null)
  const fontLayer = computed(() => layers.value.find((l) => l.id === 'font') ?? null)

  const activeLayer = computed(() => layers.value.find((l) => l.id === activeLayerId.value) ?? strokesLayer.value)

  // 중심선·번호 오버레이 레이어가 선택된 경우 실제 도형 편집 대상은 작업 획(strokes) 레이어다.
  const editableLayer = computed<LayerRecord | null>(() => {
    const cur = activeLayer.value
    if (!cur) return null
    if (cur.kind === 'MEDIANS' || cur.kind === 'NUMBERS') return strokesLayer.value
    return cur
  })

  const isEditableLocked = computed(() => {
    const cur = activeLayer.value
    const target = editableLayer.value
    if (!cur || !target) return true
    return cur.locked || target.locked || !cur.visible || !target.visible
  })

  const activeStrokes = computed<StrokeRecord[]>(() => editableLayer.value?.strokes ?? [])

  function syncFromDetail(detail: CharacterDetail) {
    layers.value = detail.layers.map(cloneLayer)
    dirtyIds.value = new Set()
    soloSnapshot.value = null
    knifeFrom.value = null
    connectPoints.value = []
    selectedMedianPointIndex.value = null
    if (!layers.value.some((l) => l.id === activeLayerId.value)) {
      activeLayerId.value = 'strokes'
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
    if (layerId === 'strokes' && selected.value) {
      const sl = strokesLayer.value
      if (sl) selected.value = { ...selected.value, strokes: sl.strokes.map(cloneStroke) }
    }
  }

  function queueMetaPatch(patch: LayerMetaPatch) {
    const prev = pendingMeta.get(patch.id) ?? { id: patch.id }
    pendingMeta.set(patch.id, { ...prev, ...patch })
    if (metaTimer) clearTimeout(metaTimer)
    metaTimer = setTimeout(() => {
      flushMetaPatches()
    }, 180)
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

  function selectLayer(layerId: string) {
    activeLayerId.value = layerId
    knifeFrom.value = null
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
    if (target?.id === 'strokes' && count > 0) {
      shown.value = Math.max(1, Math.min(count, shown.value || count))
    }
  }

  function selectTool(tool: EditorTool) {
    activeTool.value = tool
    knifeFrom.value = null
    connectPoints.value = []
    selectedMedianPointIndex.value = null
    if (tool === 'connect') {
      message.value = '윤곽 연결: 시작점 → 중간점(여러 개) → 끝점을 클릭한 뒤 Enter로 연결하세요.'
    }
  }

  function roundPt(p: Pt): Pt {
    return [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]
  }

  function pointsToClosedPath(points: Pt[]): string {
    const pts = points.map(roundPt)
    const [x0, y0] = pts[0]
    let d = `M ${x0} ${y0}`
    for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0]} ${pts[i][1]}`
    return `${d} Z`
  }

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
        : `윤곽 연결: ${connectPoints.value.length}점 지정됨 (Enter 연결 · ⌫ 되돌리기 · Esc 취소)`
  }

  function applyConnectPoint(point: Pt) {
    const target = guardUnlocked()
    if (!target) return
    const next = roundPt(point)
    const prev = connectPoints.value[connectPoints.value.length - 1]
    if (prev && Math.hypot(prev[0] - next[0], prev[1] - next[1]) < 1.5) return
    connectPoints.value = [...connectPoints.value, next]
    const n = connectPoints.value.length
    if (n === 1) message.value = '윤곽 연결: 중간점 또는 끝점을 클릭하세요.'
    else if (n === 2) message.value = '윤곽 연결: 끝점(또는 추가 중간점)을 클릭하세요. 3점 이상이면 Enter로 연결.'
    else message.value = `윤곽 연결: ${n}점 지정됨 — Enter/더블클릭으로 닫힌 윤곽 연결 (⌫ 되돌리기 · Esc 취소)`
  }

  function commitConnectOutline() {
    const target = guardUnlocked()
    if (!target) return
    if (connectPoints.value.length < 3) {
      error.value = '윤곽 연결에는 시작·중간·끝 포함 최소 3점이 필요합니다.'
      return
    }
    const path = pointsToClosedPath(connectPoints.value)
    connectPoints.value = []
    const idx = selectedStrokeIndex.value

    if (target.kind === 'FONT' && target.strokes.length === 0) {
      if (!target.paths[idx]) return
      const copy = target.paths.slice()
      copy[idx] = path
      updateTargetPaths(copy, '윤곽을 지정한 점으로 다시 연결했습니다. [레이어 저장]을 누르면 반영됩니다.')
      return
    }

    const stroke = target.strokes[idx]
    if (!stroke) return
    const median = recoverMedian(path, stroke.stroke_width)
    const pts = median.median.map((p): Pt => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10])
    const copy = target.strokes.map(cloneStroke)
    copy[idx] = {
      ...copy[idx],
      outline_path: path,
      median_points: pts.length >= 2 ? pts : copy[idx].median_points,
      stroke_width: median.width,
    }
    updateTargetStrokes(copy, `${idx + 1}획 윤곽을 지정한 점으로 다시 연결했습니다. [레이어 저장]을 누르면 반영됩니다.`)
  }

  function selectStrokeItem(index: number) {
    stopPlayback()
    selectedStrokeIndex.value = index
    selectedMedianPointIndex.value = null
    if (editableLayer.value?.id === 'strokes') {
      shown.value = index + 1
      reveal.value = 1
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
      void fetchReferenceForLayer(target.id, true)
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
      void fetchReferenceForLayer(target.id, true)
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
    const clamped = Math.max(0, Math.min(1, Math.round(opacity * 100) / 100))
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

  // ---- 도형/획 편집 작업 ----

  function updateTargetStrokes(nextStrokes: StrokeRecord[], statusMsg?: string) {
    const target = guardUnlocked()
    if (!target) return
    target.strokes = nextStrokes.map((s, idx) => ({ ...s, stroke_order: idx + 1 }))
    markDirty(target.id)
    if (target.id === 'strokes') {
      shown.value = Math.max(1, Math.min(target.strokes.length, shown.value || target.strokes.length))
    }
    if (selectedStrokeIndex.value >= target.strokes.length) {
      selectedStrokeIndex.value = Math.max(0, target.strokes.length - 1)
    }
    if (statusMsg) message.value = statusMsg
  }

  function updateTargetPaths(nextPaths: string[], statusMsg?: string) {
    const target = guardUnlocked()
    if (!target) return
    target.paths = nextPaths.slice()
    markDirty(target.id)
    if (selectedStrokeIndex.value >= target.paths.length) {
      selectedStrokeIndex.value = Math.max(0, target.paths.length - 1)
    }
    if (statusMsg) message.value = statusMsg
  }

  function moveStrokeInActive(index: number, delta: number) {
    const target = guardUnlocked()
    if (!target) return
    if (target.kind === 'FONT' && target.strokes.length === 0) {
      const next = index + delta
      if (next < 0 || next >= target.paths.length) return
      const copy = target.paths.slice()
      const [item] = copy.splice(index, 1)
      copy.splice(next, 0, item)
      updateTargetPaths(copy, '윤곽 순서를 변경했습니다.')
      selectedStrokeIndex.value = next
      return
    }
    const next = index + delta
    if (next < 0 || next >= target.strokes.length) return
    const copy = target.strokes.slice()
    const [item] = copy.splice(index, 1)
    copy.splice(next, 0, item)
    updateTargetStrokes(copy, `${index + 1}획을 ${next + 1}획 위치로 이동했습니다.`)
    selectedStrokeIndex.value = next
  }

  function setStrokeRadical(index: number, value: 0 | 1) {
    const target = guardUnlocked()
    if (!target || !target.strokes[index]) return
    target.strokes[index].is_radical = value
    markDirty(target.id)
  }

  function setStrokeCap(index: number, end: 'start' | 'end', value: CapType) {
    const target = guardUnlocked()
    if (!target || !target.strokes[index]) return
    if (end === 'start') target.strokes[index].start_cap_type = value
    else target.strokes[index].end_cap_type = value
    markDirty(target.id)
  }

  function reverseActiveStrokeMedian(index = selectedStrokeIndex.value) {
    const target = guardUnlocked()
    if (!target || !target.strokes[index]) return
    const copy = target.strokes.map(cloneStroke)
    copy[index].median_points = reverseMedian(copy[index].median_points)
    updateTargetStrokes(copy, `${index + 1}획의 기필↔수필 방향을 반전했습니다.`)
  }

  function deleteStrokeAt(index: number) {
    const target = guardUnlocked()
    if (!target) return
    if (target.kind === 'FONT' && target.strokes.length === 0) {
      if (target.paths.length <= 1) {
        error.value = '마지막 남은 윤곽은 삭제할 수 없습니다.'
        return
      }
      const copy = target.paths.filter((_, i) => i !== index)
      updateTargetPaths(copy, `${index + 1}번 윤곽을 삭제했습니다.`)
      return
    }
    if (target.strokes.length <= 1) {
      error.value = '최소 1개의 획은 남아 있어야 합니다.'
      return
    }
    const copy = target.strokes.filter((_, i) => i !== index)
    updateTargetStrokes(copy, `${index + 1}획을 삭제했습니다.`)
  }

  function mergeStrokeWithNext(index: number) {
    const target = guardUnlocked()
    if (!target || index < 0 || index + 1 >= target.strokes.length) return
    const copy = target.strokes.map(cloneStroke)
    const merged = mergeTwoStrokes(copy[index], copy[index + 1])
    copy.splice(index, 2, merged)
    updateTargetStrokes(copy, `${index + 1}획과 ${index + 2}획을 병합했습니다.`)
    selectedStrokeIndex.value = index
  }

  function copyStrokeToWorkLayer(index: number) {
    const src = editableLayer.value
    const dst = strokesLayer.value
    if (!src || !dst || src.id === 'strokes') return
    if (dst.locked) {
      error.value = '작업 획 레이어가 잠겨 있습니다. 잠금을 해제한 뒤 복사하세요.'
      return
    }
    const stroke = src.strokes[index]
    if (!stroke) return
    const next = [...dst.strokes.map(cloneStroke), cloneStroke(stroke)].map((s, idx) => ({
      ...s,
      stroke_order: idx + 1,
    }))
    dst.strokes = next
    markDirty('strokes')
    shown.value = dst.strokes.length
    message.value = `'${src.name}'의 ${index + 1}획을 작업 획 레이어 끝에 추가했습니다.`
  }

  function restoreActiveSnapshot(strokes: StrokeRecord[], paths: string[]) {
    const target = editableLayer.value
    if (!target || isEditableLocked.value) return
    target.strokes = strokes
    target.paths = paths
  }

  // 레이어/획 아핀 변환 적용
  function applyAffineToActive(fn: (x: number, y: number) => Pt, scaleFactor = 1) {
    const target = guardUnlocked()
    if (!target) return
    if (target.kind === 'FONT' && target.strokes.length === 0) {
      if (transformScope.value === 'stroke' && target.paths[selectedStrokeIndex.value]) {
        const copy = target.paths.slice()
        copy[selectedStrokeIndex.value] = transformPath(copy[selectedStrokeIndex.value], fn)
        updateTargetPaths(copy)
      } else {
        updateTargetPaths(target.paths.map((d) => transformPath(d, fn)))
      }
      return
    }
    if (transformScope.value === 'stroke' && target.strokes[selectedStrokeIndex.value]) {
      const copy = target.strokes.map(cloneStroke)
      copy[selectedStrokeIndex.value] = transformStroke(copy[selectedStrokeIndex.value], fn, scaleFactor)
      updateTargetStrokes(copy)
    } else {
      updateTargetStrokes(target.strokes.map((s) => transformStroke(s, fn, scaleFactor)))
    }
  }

  // 선택된 레퍼런스/획 레이어를 궁서체(FONT) 바운딩 박스에 원클릭 정렬
  function alignActiveToFont() {
    const target = guardUnlocked()
    const fl = fontLayer.value
    if (!target || !fl || fl.paths.length === 0) {
      error.value = '정렬 기준이 될 궁서체(TTF) 윤곽이 없습니다.'
      return
    }
    const fontBox = pathsBBox(fl.paths)
    const srcBox = target.strokes.length > 0 ? strokesBBox(target.strokes) : pathsBBox(target.paths)
    if (!fontBox || !srcBox) return
    const sw = Math.max(1, srcBox.maxX - srcBox.minX)
    const sh = Math.max(1, srcBox.maxY - srcBox.minY)
    const sx = (fontBox.maxX - fontBox.minX) / sw
    const sy = (fontBox.maxY - fontBox.minY) / sh
    applyAffineToActive(
      (x, y) => [fontBox.minX + (x - srcBox.minX) * sx, fontBox.minY + (y - srcBox.minY) * sy],
      (sx + sy) / 2,
    )
    message.value = `'${target.name}' 레이어의 위치·크기를 궁서체 윤곽 영역에 맞췄습니다.`
  }

  // 베지어 편집 결과 반영
  function updateSinglePathInActive(index: number, nextPath: string) {
    const target = guardUnlocked()
    if (!target) return
    if (target.kind === 'FONT' && target.strokes.length === 0) {
      if (!target.paths[index]) return
      const copy = target.paths.slice()
      copy[index] = nextPath
      updateTargetPaths(copy)
      return
    }
    if (!target.strokes[index]) return
    const copy = target.strokes.map(cloneStroke)
    copy[index].outline_path = nextPath
    copy[index].stroke_width = recomputeStrokeWidth(nextPath, copy[index].median_points, copy[index].stroke_width)
    updateTargetStrokes(copy)
  }

  // 중심선 정점 이동 / 추가 / 삭제
  function moveMedianVertex(strokeIdx: number, ptIdx: number, to: Pt) {
    const target = guardUnlocked()
    if (!target || !target.strokes[strokeIdx]) return
    const copy = target.strokes.map(cloneStroke)
    const pts = copy[strokeIdx].median_points
    if (!pts[ptIdx]) return
    pts[ptIdx] = [Math.round(to[0] * 10) / 10, Math.round(to[1] * 10) / 10]
    copy[strokeIdx].stroke_width = recomputeStrokeWidth(copy[strokeIdx].outline_path, pts, copy[strokeIdx].stroke_width)
    updateTargetStrokes(copy)
  }

  function addMedianVertex(strokeIdx: number, at: Pt) {
    const target = guardUnlocked()
    if (!target || !target.strokes[strokeIdx]) return
    const copy = target.strokes.map(cloneStroke)
    const { points, insertedIndex } = insertMedianPoint(copy[strokeIdx].median_points, at)
    copy[strokeIdx].median_points = points
    copy[strokeIdx].stroke_width = recomputeStrokeWidth(copy[strokeIdx].outline_path, points, copy[strokeIdx].stroke_width)
    selectedMedianPointIndex.value = insertedIndex
    updateTargetStrokes(copy, `${strokeIdx + 1}획 중심선에 정점을 추가했습니다.`)
  }

  function deleteMedianVertex(strokeIdx: number, ptIdx: number) {
    const target = guardUnlocked()
    if (!target || !target.strokes[strokeIdx]) return
    const cur = target.strokes[strokeIdx].median_points
    if (cur.length <= 2) {
      error.value = '중심선은 최소 2개의 정점이 필요합니다.'
      return
    }
    const copy = target.strokes.map(cloneStroke)
    copy[strokeIdx].median_points = removeMedianPoint(cur, ptIdx)
    copy[strokeIdx].stroke_width = recomputeStrokeWidth(
      copy[strokeIdx].outline_path,
      copy[strokeIdx].median_points,
      copy[strokeIdx].stroke_width,
    )
    selectedMedianPointIndex.value = null
    updateTargetStrokes(copy, `${strokeIdx + 1}획 중심선 정점을 삭제했습니다.`)
  }

  // 칼 분할 (모든 잠금 해제된 획 레이어 및 FONT 윤곽 레이어 지원)
  function cancelKnife() {
    knifeFrom.value = null
    message.value = '획 분할이 취소되었습니다.'
  }

  function applyKnifePoint(point: Pt) {
    const target = guardUnlocked()
    if (!target) return

    if (!knifeFrom.value) {
      knifeFrom.value = point
      message.value = '칼 분할: 자를 끝점을 클릭하세요. (Esc 취소)'
      return
    }

    const from = { x: knifeFrom.value[0], y: knifeFrom.value[1] }
    const to = { x: point[0], y: point[1] }
    knifeFrom.value = null

    if (target.kind === 'FONT' && target.strokes.length === 0) {
      const idx = selectedStrokeIndex.value
      const d = target.paths[idx]
      if (!d) return
      const parts = splitStrokeByKnife(d, from, to)
      if (!parts) {
        error.value = '윤곽 분할 불가: 선택한 윤곽 외곽선과 교차하도록 두 점을 지정하세요.'
        return
      }
      const copy = target.paths.slice()
      copy.splice(idx, 1, parts[0], parts[1])
      updateTargetPaths(copy, `윤곽을 2개로 분할했습니다. [레이어 저장]을 누르면 반영됩니다.`)
      return
    }

    const idx = selectedStrokeIndex.value
    const stroke = target.strokes[idx]
    if (!stroke) return
    const parts = splitStrokeByKnife(stroke.outline_path, from, to)
    if (!parts) {
      error.value = '획 분할 불가: 선택된 획의 외곽선과 교차하도록 두 점을 지정하세요.'
      return
    }
    const [left, right] = parts.map((path): StrokeRecord => {
      const median = recoverMedian(path, stroke.stroke_width)
      const pts = median.median.map((p): Pt => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10])
      return {
        ...stroke,
        outline_path: path,
        median_points: pts.length >= 2 ? pts : stroke.median_points,
        stroke_width: median.width,
      }
    })
    const copy = target.strokes.map(cloneStroke)
    copy.splice(idx, 1, left, right)
    updateTargetStrokes(copy, `${idx + 1}획을 2개로 분할했습니다. [레이어 저장]을 누르면 반영됩니다.`)
    selectedStrokeIndex.value = idx + 1
    if (target.id === 'strokes') shown.value = idx + 2
  }

  // ---- 서버 연동 작업 ----

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
    layers,
    panelLayers,
    orderedLayers,
    strokesLayer,
    mediansLayer,
    numbersLayer,
    fontLayer,
    activeLayerId,
    activeLayer,
    editableLayer,
    isEditableLocked,
    activeStrokes,
    activeTool,
    transformScope,
    selectedStrokeIndex,
    selectedMedianPointIndex,
    knifeFrom,
    connectPoints,
    dirtyIds,
    syncFromDetail,
    selectLayer,
    selectTool,
    selectStrokeItem,
    toggleLayerVisible,
    soloLayer,
    isSoloed,
    setPresetVisibility,
    setLayerVisibleDirect,
    setLayerOpacity,
    toggleLayerLock,
    setLayerColor,
    renameLayer,
    moveLayerOrder,
    moveStrokeInActive,
    setStrokeRadical,
    setStrokeCap,
    reverseActiveStrokeMedian,
    deleteStrokeAt,
    mergeStrokeWithNext,
    copyStrokeToWorkLayer,
    restoreActiveSnapshot,
    applyAffineToActive,
    alignActiveToFont,
    updateSinglePathInActive,
    moveMedianVertex,
    addMedianVertex,
    deleteMedianVertex,
    cancelKnife,
    applyKnifePoint,
    cancelConnect,
    undoConnectPoint,
    applyConnectPoint,
    commitConnectOutline,
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
