import { LAYER_ID } from '../shared/constants.ts'
import { matchStrokeOrder, reorderByMatch } from '../shared/strokeOrder.ts'
import type { LayerRecord } from '../shared/types.ts'

const ORDERED_LAYER_NAME = '네이버 획순 + Hanzi 모양'

// 네이버와 Hanzi 레이어의 획 수가 같으면, 모양은 Hanzi(굵기·시작·끝·꺾임) 순서는 네이버를 따른 레이어를 만든다.
// 출처 표시는 순서를 정한 네이버를 따른다. 한쪽이 없거나 획 수가 달라 짝지을 수 없으면 null이다(호출한 쪽이 레이어를 그대로 쓴다).
export function orderedReferenceLayer(layers: LayerRecord[]): LayerRecord | null {
  const naver = layers.find((item) => item.id === LAYER_ID.naver)
  const mmh = layers.find((item) => item.id === LAYER_ID.mmh)
  if (!naver || !mmh) return null
  const match = matchStrokeOrder(naver.strokes.map((stroke) => stroke.median_points), mmh.strokes.map((stroke) => stroke.median_points))
  if (!match) return null
  const strokes = reorderByMatch(mmh.strokes, match).map((stroke, index) => ({ ...stroke, stroke_order: index + 1 }))
  return { ...mmh, id: naver.id, kind: naver.kind, name: ORDERED_LAYER_NAME, source_url: naver.source_url, strokes }
}
