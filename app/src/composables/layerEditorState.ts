import { computed, ref, type ComputedRef, type Ref } from 'vue'
import type { CharacterDetail, EditorTool, LayerRecord, Pt, StrokeRecord } from '../types.ts'

export type LayerEditorState = {
  selected: Ref<CharacterDetail | null>
  shown: Ref<number>
  reveal: Ref<number>
  layers: Ref<LayerRecord[]>
  activeLayerId: Ref<string>
  activeTool: Ref<EditorTool>
  transformScope: Ref<'layer' | 'stroke'>
  selectedStrokeIndex: Ref<number>
  selectedMedianPointIndex: Ref<number | null>
  knifeFrom: Ref<Pt | null>
  connectPoints: Ref<Pt[]>
  dirtyIds: Ref<Set<string>>
  soloSnapshot: Ref<Record<string, boolean> | null>
  panelLayers: ComputedRef<LayerRecord[]>
  orderedLayers: ComputedRef<LayerRecord[]>
  strokesLayer: ComputedRef<LayerRecord | null>
  mediansLayer: ComputedRef<LayerRecord | null>
  numbersLayer: ComputedRef<LayerRecord | null>
  fontLayer: ComputedRef<LayerRecord | null>
  activeLayer: ComputedRef<LayerRecord | null>
  editableLayer: ComputedRef<LayerRecord | null>
  isEditableLocked: ComputedRef<boolean>
  activeStrokes: ComputedRef<StrokeRecord[]>
}

export function createLayerEditorState(
  selected: Ref<CharacterDetail | null>,
  shown: Ref<number>,
  reveal: Ref<number>,
): LayerEditorState {
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

  return {
    selected,
    shown,
    reveal,
    layers,
    activeLayerId,
    activeTool,
    transformScope,
    selectedStrokeIndex,
    selectedMedianPointIndex,
    knifeFrom,
    connectPoints,
    dirtyIds,
    soloSnapshot,
    panelLayers,
    orderedLayers,
    strokesLayer,
    mediansLayer,
    numbersLayer,
    fontLayer,
    activeLayer,
    editableLayer,
    isEditableLocked,
    activeStrokes,
  }
}
