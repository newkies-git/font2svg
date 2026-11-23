import { matchStrokeOrder, reorderByMatch } from '../shared/strokeOrder.ts'
import type { Pt } from '../shared/types.ts'
import { hanjaStrokes, type HanjaGlyph } from './references.ts'

export type OrderedGlyph = {
  medians: Pt[][]
  outlines: string[]
  // 부수 획의 0부터 시작하는 번호(합친 순서 기준)
  radical: number[]
  // 획의 모양을 어느 출처에서 가져왔는지
  shape: 'MMH' | 'NAVER'
}

// 획 정보의 역할 분담: NAVER는 획순만, Hanzi(MMH)는 획의 굵기·시작·끝·꺾임(모양)을 기준으로 한다.
// 두 출처의 획 수가 같으면 MMH 획을 NAVER 순서로 다시 늘어놓아 쓰고(부수 표시도 MMH 것을 따라 옮긴다),
// MMH가 없거나 획 수가 달라 짝지을 수 없으면 NAVER 획을 그대로 쓴다. NAVER에서 쓸 수 있는 획이 없으면 null이다.
export function orderedGlyph(naver: HanjaGlyph, mmh: HanjaGlyph | null): OrderedGlyph | null {
  const order = hanjaStrokes(naver)
  if (!order || order.medians.length === 0) return null
  const own: OrderedGlyph = { medians: order.medians, outlines: order.outlines, radical: naver.radical, shape: 'NAVER' }
  const shape = mmh ? hanjaStrokes(mmh) : null
  if (!mmh || !shape) return own
  const match = matchStrokeOrder(order.medians, shape.medians)
  if (!match) return own
  return {
    medians: reorderByMatch(shape.medians, match),
    outlines: reorderByMatch(shape.outlines, match),
    radical: match.flatMap((source, index) => (mmh.radical.includes(source) ? [index] : [])),
    shape: 'MMH',
  }
}
