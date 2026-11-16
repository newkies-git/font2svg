import type { LayerRecord } from '../types.ts'

// 궁서체(FONT) 레이어가 획 없이 윤곽(paths)만 가진 상태. 이때는 획이 아니라 윤곽 하나하나를 편집한다.
export function isContourLayer(layer: Pick<LayerRecord, 'kind' | 'strokes'>): boolean {
  return layer.kind === 'FONT' && layer.strokes.length === 0
}
