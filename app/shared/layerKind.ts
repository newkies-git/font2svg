import type { LayerRecord } from './types.ts'

// 외부 레퍼런스에서 받아 오는 레이어 종류(우선순위 순서는 아니다). 수신·표시·복원 가능 여부를 이 표 하나로 판단한다.
export const REFERENCE_KINDS = ['MMH', 'ACJK', 'NAVER'] as const
export type ReferenceKind = (typeof REFERENCE_KINDS)[number]

export function isReferenceKind(kind: string): kind is ReferenceKind {
  return (REFERENCE_KINDS as readonly string[]).includes(kind)
}

// 궁서체(FONT) 레이어가 획 없이 윤곽(paths)만 가진 상태. 이때는 획이 아니라 윤곽 하나하나를 편집한다.
export function isContourLayer(layer: Pick<LayerRecord, 'kind' | 'strokes'>): boolean {
  return layer.kind === 'FONT' && layer.strokes.length === 0
}
