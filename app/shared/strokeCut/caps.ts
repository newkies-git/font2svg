import type { CapType, Pt } from '../types.ts'
import type { Pt as Point } from '../paths.ts'
import { outlineOfMask } from './contour.ts'
import type { KnifeFace } from './knife.ts'
import { pixelToFont, rasterizeOutline, type Raster } from './raster.ts'

// 획의 기필(시작)·수필(끝) 모양을 윤곽에 반영한다. 끝에서 안쪽으로 길이 length(획 폭 배수)만큼의 구간을
// 끝점으로부터의 거리 s(0~1)에 따른 반폭 비율 radius(s)로 다듬는다. 1보다 크면 부풀고, 작으면 깎인다.
export type CapShape = Exclude<CapType, 'NONE' | 'REF_STAMP' | 'MANUAL'>
type CapProfile = { length: number; radius: (s: number) => number }

const BULGE_AMOUNT = 0.25
const TAPER_POWER = 1.6
const roundRadius = (s: number) => Math.sqrt(1 - (1 - s) ** 2)

const CAP_PROFILES: Record<CapShape, CapProfile> = {
  AUTO_ROUND: { length: 0.5, radius: roundRadius },
  POINTED: { length: 0.9, radius: (s) => s },
  BULGE: { length: 0.7, radius: (s) => roundRadius(s) * (1 + BULGE_AMOUNT * Math.sin(Math.PI * s)) },
  TAPER: { length: 1.6, radius: (s) => s ** TAPER_POWER },
}

const MAX_CAP_LENGTH = Math.max(...Object.values(CAP_PROFILES).map((profile) => profile.length))
// 모양을 다듬는 구간이 중심선 길이에서 차지할 수 있는 최대 비율
const MAX_ZONE_CHAIN_RATIO = 0.45
// 끝점 주변에서 끝(tip)·접선·폭을 잴 때 보는 범위(획 폭 배수)
const NEAR_RATIO = 1.5
const TANGENT_SPAN_RATIO = 0.5
// 다듬는 구간에서 획 중심으로부터 이 배수(반폭 기준)를 넘는 픽셀은 건드리지 않는다.
const ZONE_SIDE_RATIO = 2
// 구간 안쪽 가장자리에서 반폭을 잴 때 쓰는 띠 두께(픽셀)
const EDGE_BAND_PX = 2

// 칼 단면(face)과 중심선 끝을 짝지을 때: 끝점이 단면 중심에서 단면 폭의 이 배수 이내이고, 끝이 향하는 방향이 단면의 바깥 방향과 이 값(코사인) 이상 같아야 한다.
const MATCH_REACH_RATIO = 2
const MATCH_MIN_COS = 0.7

export function isCapShape(type: CapType): type is CapShape {
  return Object.hasOwn(CAP_PROFILES, type)
}

// 이 모양이 끝에서 차지하는 길이(글꼴 좌표)
export function capLength(shape: CapShape, width: number): number {
  return CAP_PROFILES[shape].length * width
}

type EndFrame = { origin: Point; along: Point; normal: Point; chainLength: number }

// 중심선 끝점과 바깥쪽 방향(along), 그 수직(normal)
function endFrame(median: Pt[], end: 'start' | 'end', width: number): EndFrame | null {
  const chain = end === 'start' ? median : median.slice().reverse()
  const origin = { x: chain[0][0], y: chain[0][1] }
  let chainLength = 0
  let inner = chain[1]
  let reached = false
  for (let i = 1; i < chain.length; i++) {
    chainLength += Math.hypot(chain[i][0] - chain[i - 1][0], chain[i][1] - chain[i - 1][1])
    if (!reached && Math.hypot(chain[i][0] - origin.x, chain[i][1] - origin.y) >= width * TANGENT_SPAN_RATIO) {
      inner = chain[i]
      reached = true
    }
  }
  const dx = origin.x - inner[0]
  const dy = origin.y - inner[1]
  const length = Math.hypot(dx, dy)
  if (length === 0) return null
  const along = { x: dx / length, y: dy / length }
  return { origin, along, normal: { x: -along.y, y: along.x }, chainLength }
}

// 칼 단면(face)에 해당하는 중심선 끝(시작이면 'start', 끝이면 'end'). 짝이 없으면 null.
// 합쳐진 조각처럼 중심선이 그 단면까지 가지 않는 경우가 null이다.
export function matchMedianEnd(median: Pt[], face: KnifeFace): 'start' | 'end' | null {
  if (median.length < 2) return null
  let best: { end: 'start' | 'end'; distance: number } | null = null
  for (const end of ['start', 'end'] as const) {
    const frame = endFrame(median, end, face.width)
    if (!frame) continue
    const distance = Math.hypot(frame.origin.x - face.origin.x, frame.origin.y - face.origin.y)
    const facing = frame.along.x * face.along.x + frame.along.y * face.along.y
    if (distance > face.width * MATCH_REACH_RATIO || facing < MATCH_MIN_COS) continue
    if (!best || distance < best.distance) best = { end, distance }
  }
  return best?.end ?? null
}

// 획의 한쪽 끝(end)에 모양을 적용한 새 윤곽. 적용할 수 없으면 null.
// restore가 true면 먼저 그 끝을 기본(깎이지 않은) 폭으로 되돌린 뒤 모양을 적용하므로, 다른 모양으로 바꿔도 앞 모양이 남지 않는다.
// shape가 null이면 되돌리기만 한다. 끝 구간은 일정한 폭으로 다시 그려지므로 구간 안에서 폭이 변하던 획은 평평해진다.
export function applyCapShape(outline: string, median: Pt[], end: 'start' | 'end', shape: CapShape | null, width: number, restore: boolean): string | null {
  if (median.length < 2) return null
  const frame = endFrame(median, end, width)
  return frame ? applyCapAtFrame(outline, frame, shape, width, restore) : null
}

// 칼 단면(face)이 만든 끝에 모양을 적용한다. 칼로 가른 직후 중심선 없이도 단면의 위치·방향·폭으로 끝을 찾는다.
export function applyCapAtFace(outline: string, face: KnifeFace, shape: CapShape | null, restore: boolean): string | null {
  const normal = { x: -face.along.y, y: face.along.x }
  return applyCapAtFrame(outline, { origin: face.origin, along: face.along, normal, chainLength: face.depth }, shape, face.width, restore)
}

// 끝점 기준으로 잰 격자 좌표: along은 바깥쪽으로 잰 거리, side는 옆으로 잰 거리
type EndGrid = { along: Float32Array; side: Float32Array }

function gridOf(raster: Raster, frame: EndFrame): EndGrid {
  const { origin, along, normal } = frame
  const grid = { along: new Float32Array(raster.ink.length), side: new Float32Array(raster.ink.length) }
  for (let i = 0; i < raster.ink.length; i++) {
    const pt = pixelToFont(raster, i)
    const px = pt.x - origin.x
    const py = pt.y - origin.y
    grid.along[i] = px * along.x + py * along.y
    grid.side[i] = px * normal.x + py * normal.y
  }
  return grid
}

// 끝의 위치와 폭: tip은 끝점이 놓인 바깥쪽 거리의 최댓값, zone은 모양을 다듬는 구간의 최대 길이,
// halfWidth·center는 구간 안쪽 가장자리에서 잰 반폭과 옆 중심이다.
type EndMeasure = { tip: number; zone: number; halfWidth: number; center: number }

function measureEnd(raster: Raster, grid: EndGrid, frame: EndFrame, width: number): EndMeasure | null {
  const { ink } = raster
  const near = width * NEAR_RATIO
  let tip = -Infinity
  for (let i = 0; i < ink.length; i++) {
    if (ink[i] && Math.abs(grid.side[i]) <= near && grid.along[i] >= -near && grid.along[i] > tip) tip = grid.along[i]
  }
  if (tip === -Infinity) return null
  const zone = Math.min(MAX_CAP_LENGTH * width, MAX_ZONE_CHAIN_RATIO * frame.chainLength)
  const band = EDGE_BAND_PX / raster.scale
  let minSide = Infinity
  let maxSide = -Infinity
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i]) continue
    const t = tip - grid.along[i]
    if (t < zone || t > zone + band || Math.abs(grid.side[i]) > near) continue
    if (grid.side[i] < minSide) minSide = grid.side[i]
    if (grid.side[i] > maxSide) maxSide = grid.side[i]
  }
  if (minSide === Infinity) return null
  return { tip, zone, halfWidth: (maxSide - minSide) / 2, center: (maxSide + minSide) / 2 }
}

// 끝 구간(끝점에서 zone까지)을 다시 그린 마스크. restore면 구간을 기본 폭으로 채운 뒤 shape의 반폭 곡선으로 깎거나 부풀린다.
function shapedMask(raster: Raster, grid: EndGrid, measure: EndMeasure, width: number, shape: CapShape | null, restore: boolean): Uint8Array {
  const { ink } = raster
  const { tip, zone, halfWidth, center } = measure
  const length = shape ? Math.min(CAP_PROFILES[shape].length * width, zone) : 0
  const result = ink.slice()
  for (let i = 0; i < ink.length; i++) {
    const t = tip - grid.along[i]
    if (t < 0 || t > zone) continue
    const side = Math.abs(grid.side[i] - center)
    if (side > halfWidth * ZONE_SIDE_RATIO) continue
    const base = ink[i] || (restore && side <= halfWidth) ? 1 : 0
    if (!shape || t > length) {
      result[i] = base
      continue
    }
    const ratio = CAP_PROFILES[shape].radius(t / length)
    result[i] = side <= ratio * halfWidth && (base || ratio > 1) ? 1 : 0
  }
  return result
}

function applyCapAtFrame(outline: string, frame: EndFrame, shape: CapShape | null, width: number, restore: boolean): string | null {
  if (!shape && !restore) return null
  const raster = rasterizeOutline(outline)
  if (!raster) return null
  const grid = gridOf(raster, frame)
  const measure = measureEnd(raster, grid, frame, width)
  return measure ? outlineOfMask(shapedMask(raster, grid, measure, width, shape, restore), raster) : null
}
