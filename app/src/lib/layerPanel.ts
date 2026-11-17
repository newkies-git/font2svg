import { LAYER_ID } from '../../shared/constants.ts'
import { isReferenceKind } from '../../shared/layerKind.ts'
import type { LayerRecord } from '../../shared/types.ts'

// 이 레이어만 보이면 단독 보기 상태다.
export function isSoloedLayer(layers: LayerRecord[], layerId: string): boolean {
  const target = layers.find((layer) => layer.id === layerId)
  if (!target || !target.visible) return false
  return !layers.some((layer) => layer.id !== layerId && layer.visible)
}

// 아직 받지 않은 레퍼런스 레이어만 원격에서 수신할 수 있다.
export function canFetch(layer: LayerRecord): boolean {
  return !layer.available && isReferenceKind(layer.kind)
}

export function canApplyToStrokes(layer: LayerRecord | null): boolean {
  if (!layer) return false
  return layer.id !== LAYER_ID.strokes && layer.strokes.length > 0
}

// 원본이 있는 레이어(궁서체·윤곽·레퍼런스)를 고쳤거나 저장 전 변경이 있을 때만 원본으로 되돌릴 수 있다.
export function canReset(layer: LayerRecord | null, dirtyIds: ReadonlySet<string>): boolean {
  if (!layer) return false
  if (layer.kind !== 'FONT' && layer.kind !== 'OUTLINE' && !isReferenceKind(layer.kind)) return false
  return layer.modified || dirtyIds.has(layer.id)
}

export function layerCountText(layer: LayerRecord): string {
  if (layer.kind === 'MEDIANS' || layer.kind === 'NUMBERS') return ''
  if (layer.strokes.length > 0) return `${layer.strokes.length}획`
  if (layer.paths.length > 0) return `윤곽 ${layer.paths.length}`
  return layer.kind === 'OUTLINE' ? '미생성' : '미수신'
}

export function thumbPaths(layer: LayerRecord): string[] {
  if (layer.strokes.length > 0) return layer.strokes.map((stroke) => stroke.outline_path).filter(Boolean)
  return layer.paths
}
