import type { LayerRecord } from './types.ts'

// 외부 레퍼런스에서 받아 오는 레이어 종류(우선순위는 아래 REFERENCE_PRIORITY). 수신·표시·복원 가능 여부를 이 표 하나로 판단한다.
const REFERENCE_KINDS = ['MMH', 'NAVER'] as const
export type ReferenceKind = (typeof REFERENCE_KINDS)[number]

// 같은 글자에 여러 출처가 있을 때 쓰는 순서. 한국 한자의 획순은 NAVER가 맞고 Hanzi(MMH)와 다른 글자가 있다(약 10%)이므로 NAVER를 가장 먼저 본다.
export const REFERENCE_PRIORITY: readonly ReferenceKind[] = ['NAVER', 'MMH']

// 출처의 우선순위 번호(작을수록 우선). 목록에 없는 출처는 맨 뒤다.
export function referenceRank(source: string): number {
  const index = (REFERENCE_PRIORITY as readonly string[]).indexOf(source)
  return index === -1 ? REFERENCE_PRIORITY.length : index
}

export function isReferenceKind(kind: string): kind is ReferenceKind {
  return (REFERENCE_KINDS as readonly string[]).includes(kind)
}

// 궁서체(FONT) 레이어가 획 없이 윤곽(paths)만 가진 상태. 이때는 획이 아니라 윤곽 하나하나를 편집한다.
export function isContourLayer(layer: Pick<LayerRecord, 'kind' | 'strokes'>): boolean {
  return layer.kind === 'FONT' && layer.strokes.length === 0
}
