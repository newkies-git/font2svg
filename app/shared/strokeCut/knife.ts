import { DEFAULT_STROKE_WIDTH, MIN_STROKE_WIDTH } from '../constants.ts'
import { flattenContours, type Pt } from '../paths.ts'
import { outlineOfMask } from './contour.ts'
import { knifeSegments, locate, segmentAt, type KnifeSegment } from './polyline.ts'
import { pixelToFont, rasterize } from './raster.ts'

// 칼 분할과 중심선 기준 분할이 윤곽을 평탄화할 때 쓰는 허용 오차
export const KNIFE_FLATNESS = 1.4
// 칼 선 전체 길이의 최소값(글꼴 좌표)
export const KNIFE_MIN_LENGTH = 4
// 칼로 나눈 조각이 상대 조각의 접합부로 넘어가 겹치는 기본 깊이: 기본 획 폭 대비 비율.
// 겹치지 않으면 칼이 경계에서 조금만 어긋나도 한쪽 조각이 파이거나 상대의 뿌리가 혹으로 남는다.
const KNIFE_OVERLAP_RATIO = 0.1
export const KNIFE_OVERLAP = DEFAULT_STROKE_WIDTH * KNIFE_OVERLAP_RATIO
// 칼에 닿은 픽셀로 보는 거리(픽셀 단위)
const KNIFE_CONTACT_PX = 1.5
// 칼에 닿은 구간이 이보다 얇으면(획 최소 폭 대비 비율) 칼이 획 가장자리에서 조금 어긋나 남은 띠로 보고 지운다.
// 사람이 경계에 칼을 정확히 대기 어렵고 윤곽 다시 따기 오차도 쌓이므로, 획 최소 폭의 이 비율(글꼴 좌표 10 안팎)까지 어긋남을 받아 준다.
const KNIFE_SLIVER_RATIO = 0.25
const KNIFE_SLIVER_DEPTH = MIN_STROKE_WIDTH * KNIFE_SLIVER_RATIO
// 칼 선에서 수직으로 이 거리(픽셀) 이하로 끊긴 잉크는 같은 덩어리로 본다(칼에 닿은 두께를 잴 때).
const KNIFE_RUN_GAP_PX = 1.5
// 칼을 따라 이 칸 수 이하로 끊긴 접촉은 한 구간으로 본다.
const KNIFE_SPAN_GAP_PX = 2
// 조각으로 인정하는 덩어리의 최소 크기: 잉크 전체 픽셀 대비 비율. 이보다 작은 부스러기는 버린다.
export const KNIFE_MIN_PIECE_RATIO = 0.01
// 칼에 닿은 구간이 획의 끝(기필·수필 단면)이려면: 폭이 이 범위이고, 조각 깊이의 이 배수 이하여야 한다.
// 구간이 획 길이만큼 길면(칼이 획의 긴 변을 따라 지날 때) 끝이 아니다.
const KNIFE_END_MIN_WIDTH = 8
const KNIFE_END_MAX_WIDTH = DEFAULT_STROKE_WIDTH * 1.5
const KNIFE_END_MAX_WIDTH_TO_DEPTH = 1.5
// 단면의 양옆(칼을 따라 이 칸 수 안쪽)에서 같은 조각의 잉크가 칼에서 이 거리(픽셀) 이내에 있으면, 조각이 칼과 나란히 이어지는 접합부라 끝이 아니다.
// 앞 단계 윤곽의 오차로 칼이 획의 긴 변에서 몇 단위 떨어져 지나갈 때, 접합부 한 구간만 칼에 닿아 끝처럼 보이는 것을 막는다.
const KNIFE_FLANK_DISTANCE_PX = 8
const KNIFE_FLANK_REACH_PX = 6

// 칼 단면 중 획의 끝(기필·수필)으로 보이는 구간.
// origin은 칼 선 위 구간의 가운데, along은 그 조각에서 상대 조각 쪽으로 향하는 단위 벡터(획의 끝이 바깥을 향하는 방향),
// width는 구간의 폭(그 자리의 실제 획 폭), depth는 구간에서 조각 안쪽으로 잰 깊이다. 모두 글꼴 좌표.
export type KnifeFace = { origin: Pt; along: Pt; width: number; depth: number }
export type KnifePiece = { path: string; ends: KnifeFace[] }

export type KnifeOptions = {
  // 획의 끝 단면에서 상대 조각 안쪽으로 겹칠 깊이(글꼴 좌표)를 구간 폭으로 정한다. 없으면 기본 깊이.
  endOverlap?: (width: number) => number
}

type CutField = {
  // 칼 선까지의 부호 있는 거리(픽셀 단위, 양수가 왼쪽)와 칼을 따라 잰 위치(픽셀 단위)
  distancePx: Float32Array
  alongPx: Float32Array
}

type Span = { min: number; max: number }

// 칼을 따라 잰 위치마다, 칼 선에 닿은 잉크가 수직으로 이어진 두께(픽셀). 닿지 않은 위치는 담기지 않는다.
// 같은 위치에 칼에서 떨어진 다른 덩어리(구멍 건너편의 획 등)가 있어도 닿은 덩어리만 잰다.
function touchDepths(pixels: Iterable<number>, field: CutField): Map<number, number> {
  const distancesAt = new Map<number, number[]>()
  for (const index of pixels) {
    const position = Math.round(field.alongPx[index])
    const list = distancesAt.get(position)
    if (list) list.push(Math.abs(field.distancePx[index]))
    else distancesAt.set(position, [Math.abs(field.distancePx[index])])
  }
  const depths = new Map<number, number>()
  for (const [position, list] of distancesAt) {
    list.sort((a, b) => a - b)
    if (list[0] > KNIFE_CONTACT_PX) continue
    let run = list[0]
    for (const distance of list) {
      if (distance - run > KNIFE_RUN_GAP_PX) break
      run = distance
    }
    depths.set(position, run)
  }
  return depths
}

// 칼 선에 한두 칸 두께로만 닿은 띠(획 가장자리가 칼과 나란할 때, 구멍 가장자리에 래스터 오차로 생김)를 뺀 사본을 돌려준다.
// 이런 띠가 남으면 칼에 닿은 구간이 획 길이 전체로 잡혀 겹침이 엉뚱하게 번진다.
function withoutSlivers(source: Uint8Array, field: CutField, minDepthPx: number): Uint8Array {
  const mask = source.slice()
  const pixels: number[] = []
  for (let i = 0; i < mask.length; i++) if (mask[i]) pixels.push(i)
  const depths = touchDepths(pixels, field)
  for (const index of pixels) {
    const depth = depths.get(Math.round(field.alongPx[index]))
    if (depth !== undefined && depth < minDepthPx && Math.abs(field.distancePx[index]) <= depth) mask[index] = 0
  }
  return mask
}

// 마스크를 8방향으로 이어진 덩어리로 나눈다(윤곽 추적과 같은 연결). 큰 덩어리부터.
export function connectedComponents(mask: Uint8Array, w: number, h: number): number[][] {
  const seen = new Uint8Array(mask.length)
  const components: number[][] = []
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue
    const pixels: number[] = []
    const stack = [start]
    seen[start] = 1
    while (stack.length > 0) {
      const index = stack.pop() as number
      pixels.push(index)
      const x = index % w
      const y = (index / w) | 0
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const next = ny * w + nx
          if (mask[next] && !seen[next]) {
            seen[next] = 1
            stack.push(next)
          }
        }
      }
    }
    components.push(pixels)
  }
  return components.sort((a, b) => b.length - a.length)
}

// 덩어리가 칼 선에 닿은 구간들(칼을 따라 잰 위치의 연속 범위)
function contactSpans(pixels: number[], field: CutField): Span[] {
  const positions = new Set<number>()
  for (const index of pixels) {
    if (Math.abs(field.distancePx[index]) <= KNIFE_CONTACT_PX) positions.add(Math.round(field.alongPx[index]))
  }
  const sorted = [...positions].sort((a, b) => a - b)
  const spans: Span[] = []
  for (const position of sorted) {
    const last = spans[spans.length - 1]
    if (last && position - last.max <= KNIFE_SPAN_GAP_PX) last.max = position
    else spans.push({ min: position, max: position })
  }
  return spans
}

// 덩어리의 잉크가 칼에서 KNIFE_FLANK_DISTANCE_PX 이내에 있는, 칼을 따라 잰 위치들
function positionsNearLine(pixels: number[], field: CutField): Set<number> {
  const positions = new Set<number>()
  for (const index of pixels) {
    if (Math.abs(field.distancePx[index]) <= KNIFE_FLANK_DISTANCE_PX) positions.add(Math.round(field.alongPx[index]))
  }
  return positions
}

// 구간이 획의 끝 단면이면 그 면을, 아니면 null. facing은 이 조각에서 상대 조각 쪽 법선 방향의 부호(왼쪽 조각 -1, 오른쪽 조각 +1).
function faceOfSpan(span: Span, field: CutField, pixels: number[], scale: number, segments: KnifeSegment[], facing: number): KnifeFace | null {
  const nearLine = positionsNearLine(pixels, field)
  for (let reach = 1; reach <= KNIFE_FLANK_REACH_PX; reach++) {
    if (nearLine.has(span.min - reach) || nearLine.has(span.max + reach)) return null
  }
  const width = (span.max - span.min + 1) / scale
  let depthPx = 0
  for (const index of pixels) {
    const position = Math.round(field.alongPx[index])
    if (position >= span.min && position <= span.max) depthPx = Math.max(depthPx, Math.abs(field.distancePx[index]))
  }
  const depth = depthPx / scale
  if (width < KNIFE_END_MIN_WIDTH || width > KNIFE_END_MAX_WIDTH || width > depth * KNIFE_END_MAX_WIDTH_TO_DEPTH) return null
  const center = (span.min + span.max) / 2 / scale
  const segment = segmentAt(segments, center)
  const offset = center - segment.start
  return {
    origin: { x: segment.a.x + segment.ux * offset, y: segment.a.y + segment.uy * offset },
    along: { x: facing * segment.uy, y: -facing * segment.ux },
    width,
    depth,
  }
}

// 덩어리(own)에 상대 쪽 잉크(other)를 구간별 깊이만큼 더한다. 칼에 닿은 구간 안에서만 겹쳐 획 폭 밖으로 번지지 않는다.
function extendComponent(pixels: number[], other: Uint8Array, field: CutField, depthByPosition: Map<number, number>): Uint8Array {
  const extended = new Uint8Array(other.length)
  for (const index of pixels) extended[index] = 1
  for (let i = 0; i < other.length; i++) {
    if (!other[i]) continue
    const position = Math.round(field.alongPx[i])
    const depth = Math.max(depthByPosition.get(position) ?? 0, depthByPosition.get(position - 1) ?? 0, depthByPosition.get(position + 1) ?? 0)
    if (depth > 0 && Math.abs(field.distancePx[i]) <= depth) extended[i] = 1
  }
  return extended
}

// 칼 선(점 둘 이상을 이은 꺾인 선, 처음·끝은 무한히 연장)으로 윤곽을 가른다. 점이 둘이면 직선이다.
// 선의 한쪽에서 떨어진 덩어리가 여럿이면 덩어리마다 조각이 된다.
// 각 조각은 칼에 닿은 구간에서 상대 조각 쪽으로 겹치고, 그 구간이 획의 끝(기필·수필)이면 ends에 담긴다.
// 칼이 너무 짧거나 양쪽에 조각이 하나씩도 없으면 null.
export function splitStrokeByKnife(strokePath: string, knife: readonly Pt[], options: KnifeOptions = {}): KnifePiece[] | null {
  const segments = knifeSegments(knife)
  if (segments.length === 0) return null
  const last = segments[segments.length - 1]
  if (last.start + last.length < KNIFE_MIN_LENGTH) return null
  const contours = flattenContours(strokePath, KNIFE_FLATNESS)
  if (contours.length === 0) return null
  const raster = rasterize(contours)
  const { w, h, ink } = raster
  const leftMask = new Uint8Array(w * h)
  const rightMask = new Uint8Array(w * h)
  const field: CutField = { distancePx: new Float32Array(w * h), alongPx: new Float32Array(w * h) }
  let totalInk = 0
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i]) continue
    totalInk++
    const pt = pixelToFont(raster, i)
    const { signed, along } = locate(segments, pt.x, pt.y)
    field.distancePx[i] = signed * raster.scale
    field.alongPx[i] = along * raster.scale
    if (signed >= 0) leftMask[i] = 1
    else rightMask[i] = 1
  }

  const minPieceSize = totalInk * KNIFE_MIN_PIECE_RATIO
  const sliverPx = KNIFE_SLIVER_DEPTH * raster.scale
  const toPx = (depth: number) => Math.max(1, Math.round(depth * raster.scale))
  // 칼 왼쪽 조각은 오른쪽(상대)으로, 오른쪽 조각은 왼쪽으로 향한다. 띠를 뺀 사본이 조각의 몸이고, 가져올 재료는 띠를 포함한 원본이다
  // (칼이 경계 안쪽으로 들어가도 파임을 메우기 위해).
  const sides = [
    { own: withoutSlivers(leftMask, field, sliverPx), other: rightMask, facing: -1 },
    { own: withoutSlivers(rightMask, field, sliverPx), other: leftMask, facing: 1 },
  ]
  const piecesBySide = sides.map((side): KnifePiece[] => {
    const pieces: KnifePiece[] = []
    for (const pixels of connectedComponents(side.own, w, h)) {
      if (pixels.length < minPieceSize) continue
      const ends: KnifeFace[] = []
      const depthByPosition = new Map<number, number>()
      for (const span of contactSpans(pixels, field)) {
        const face = faceOfSpan(span, field, pixels, raster.scale, segments, side.facing)
        if (face) ends.push(face)
        const depth = toPx(face && options.endOverlap ? options.endOverlap(face.width) : KNIFE_OVERLAP)
        for (let position = span.min; position <= span.max; position++) depthByPosition.set(position, depth)
      }
      const path = outlineOfMask(extendComponent(pixels, side.other, field, depthByPosition), raster)
      if (path) pieces.push({ path, ends })
    }
    return pieces
  })
  return piecesBySide.every((pieces) => pieces.length > 0) ? piecesBySide.flat() : null
}
