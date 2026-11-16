import type { Pt } from '../paths.ts'
import { outlineOfMask } from './contour.ts'
import { KNIFE_MIN_LENGTH, KNIFE_MIN_PIECE_RATIO } from './knife.ts'
import { connectedComponents } from './mask.ts'
import { knifeSegments, locate, type KnifeSegment } from './polyline.ts'
import { pixelToFont, rasterizeOutline, type Raster } from './raster.ts'

// 획 추출(교차 분리): 분리하려는 획의 중심을 따라 안내선을 긋고, 그 획과 나머지로 나눈다.
// 교차해서 겹친 곳(十의 가운데처럼 안내선을 따라 단면이 획 두께보다 훨씬 긴 곳)은 두 쪽 모두에 넣어, 두 획이 교차부를 함께 가진다.
// 칼 분할은 교차부를 한쪽에만 주므로 교차하는 획을 따로 만들 수 없다.

// 안내선에 닿은 잉크로 보는 거리(픽셀)
const GUIDE_CONTACT_PX = 1.5
// 안내선에서 수직으로 이 거리(픽셀) 이하로 끊긴 잉크는 이어진 것으로 본다.
const GUIDE_RUN_GAP_PX = 1.5
// 획 두께를 잴 수 있는 최소 위치 수
const GUIDE_MIN_POSITIONS = 3
// 획 띠의 두께에 더하는 여유(픽셀): 윤곽을 다시 딸 때의 가장자리 오차
const BAND_SLACK_PX = 2
// 이 배수보다 단면이 길면 다른 획이 가로지르는 교차부로 본다.
const JUNCTION_RATIO = 1.4

export type ExtractedPieces = { stroke: string[]; rest: string[] }

function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// 오름차순 거리 목록에서 안내선(거리 0)에 붙어 이어진 잉크의 끝 거리. 선에 닿지 않았으면 0.
function runLength(sorted: number[]): number {
  if (sorted.length === 0 || sorted[0] > GUIDE_CONTACT_PX) return 0
  let end = sorted[0]
  for (const distance of sorted) {
    if (distance - end > GUIDE_RUN_GAP_PX) break
    end = distance
  }
  return end
}

// 안내선 둘레의 격자 값: signed는 안내선까지의 부호 있는 거리(픽셀, 양수가 왼쪽), position은 안내선을 따라 잰 위치 번호,
// pixelsAt은 위치마다 그 위치의 잉크 픽셀 목록, totalInk는 잉크 픽셀 수이다.
type GuideField = { signed: Float32Array; position: Int32Array; pixelsAt: Map<number, number[]>; totalInk: number }

function guideFieldOf(raster: Raster, segments: KnifeSegment[]): GuideField {
  const { ink } = raster
  const field: GuideField = { signed: new Float32Array(ink.length), position: new Int32Array(ink.length), pixelsAt: new Map(), totalInk: 0 }
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i]) continue
    field.totalInk++
    const pt = pixelToFont(raster, i)
    const found = locate(segments, pt.x, pt.y)
    field.signed[i] = found.signed * raster.scale
    field.position[i] = Math.round(found.along * raster.scale)
    const list = field.pixelsAt.get(field.position[i])
    if (list) list.push(i)
    else field.pixelsAt.set(field.position[i], [i])
  }
  return field
}

// 안내선을 따라 잰 획의 두께(thickness)와 중심 어긋남(center, 양수가 왼쪽), 교차부로 보는 위치들(junctions)
type StrokeMeasure = { thickness: number; center: number; junctions: Set<number> }

function measureStroke(field: GuideField): StrokeMeasure | null {
  // 안내선을 따라 위치마다, 선에 붙어 이어진 잉크의 두께와 중심 어긋남을 잰다.
  const thicknessAt = new Map<number, number>()
  const offsets: number[] = []
  for (const [at, list] of field.pixelsAt) {
    const left = runLength(list.filter((i) => field.signed[i] >= 0).map((i) => field.signed[i]).sort((a, b) => a - b))
    const right = runLength(list.filter((i) => field.signed[i] < 0).map((i) => -field.signed[i]).sort((a, b) => a - b))
    if (left + right === 0) continue
    thicknessAt.set(at, left + right)
    offsets.push((left - right) / 2)
  }
  if (thicknessAt.size < GUIDE_MIN_POSITIONS) return null
  const thickness = median([...thicknessAt.values()])
  const junctions = new Set<number>()
  for (const [at, value] of thicknessAt) if (value > thickness * JUNCTION_RATIO) junctions.add(at)
  return { thickness, center: median(offsets), junctions }
}

// 안내선에 닿은 획의 마스크(stroke)와 나머지 마스크(rest). 교차부는 두 마스크 모두에 들어간다.
function strokeAndRestMasks(raster: Raster, field: GuideField, measure: StrokeMeasure): { stroke: Uint8Array; rest: Uint8Array } {
  const { w, h, ink } = raster
  const { signed, position } = field
  const isJunction = (index: number) => [0, -1, 1].some((shift) => measure.junctions.has(position[index] + shift))
  const band = new Uint8Array(ink.length)
  const halfBand = measure.thickness / 2 + BAND_SLACK_PX
  for (let i = 0; i < ink.length; i++) if (ink[i] && Math.abs(signed[i] - measure.center) <= halfBand) band[i] = 1
  // 안내선에 닿은 덩어리만 획이고, 띠 안에 있어도 안내선과 이어지지 않은 덩어리는 나머지로 둔다.
  const stroke = new Uint8Array(ink.length)
  for (const pixels of connectedComponents(band, w, h)) {
    if (pixels.some((index) => Math.abs(signed[index]) <= GUIDE_CONTACT_PX)) for (const index of pixels) stroke[index] = 1
  }
  const rest = new Uint8Array(ink.length)
  for (let i = 0; i < ink.length; i++) if (ink[i] && (!stroke[i] || isJunction(i))) rest[i] = 1
  return { stroke, rest }
}

// 마스크의 덩어리마다 윤곽 경로를 만든다. minSize보다 작은 덩어리는 버린다.
function outlinesOfMask(mask: Uint8Array, raster: Raster, minSize: number): string[] {
  return connectedComponents(mask, raster.w, raster.h)
    .filter((pixels) => pixels.length >= minSize)
    .map((pixels) => {
      const piece = new Uint8Array(mask.length)
      for (const index of pixels) piece[index] = 1
      return outlineOfMask(piece, raster)
    })
    .filter((path): path is string => path !== null)
}

// 안내선(점 둘 이상을 이은 꺾인 선)을 따라 획을 뽑는다. 안내선에 닿은 획이 stroke, 나머지가 rest이다.
// 안내선이 윤곽과 만나지 않거나 한쪽이 비면 null.
export function extractStrokeAlongGuide(strokePath: string, guide: readonly Pt[]): ExtractedPieces | null {
  const segments = knifeSegments(guide)
  if (segments.length === 0) return null
  const last = segments[segments.length - 1]
  if (last.start + last.length < KNIFE_MIN_LENGTH) return null
  const raster = rasterizeOutline(strokePath)
  if (!raster) return null
  const field = guideFieldOf(raster, segments)
  const measure = measureStroke(field)
  if (!measure) return null
  const masks = strokeAndRestMasks(raster, field, measure)
  const minSize = field.totalInk * KNIFE_MIN_PIECE_RATIO
  const result = { stroke: outlinesOfMask(masks.stroke, raster, minSize), rest: outlinesOfMask(masks.rest, raster, minSize) }
  return result.stroke.length > 0 && result.rest.length > 0 ? result : null
}
