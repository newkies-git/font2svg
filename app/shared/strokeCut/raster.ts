import { flattenContours, type Pt } from '../paths.ts'

// 윤곽을 격자(래스터)로 옮기고 격자 좌표와 글꼴 좌표를 오가는 기반 코드.
// 획 윤곽을 격자로 옮기기 전에 곡선을 펴는 허용 오차(글꼴 좌표)
export const OUTLINE_FLATNESS = 1.4
const PAD = 16
const TARGET = 560

export type Raster = {
  w: number
  h: number
  ink: Uint8Array
  minX: number
  maxY: number
  scale: number
  pad: number
}

// 윤곽이 너무 작거나 골격을 못 만드는 등, 입력 모양 때문에 예상되는 실패. 호출한 쪽이 대체값으로 넘어가며 경고하지 않는다.
export class GeometryError extends Error {}

export function rasterize(contours: Pt[][]): Raster {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const contour of contours) {
    for (const point of contour) {
      if (point.x < minX) minX = point.x
      if (point.y < minY) minY = point.y
      if (point.x > maxX) maxX = point.x
      if (point.y > maxY) maxY = point.y
    }
  }
  const bw = Math.max(1, maxX - minX)
  const bh = Math.max(1, maxY - minY)
  const scale = TARGET / Math.max(bw, bh)
  const w = Math.ceil(bw * scale) + PAD * 2
  const h = Math.ceil(bh * scale) + PAD * 2
  const ink = new Uint8Array(w * h)
  const edges: { y0: number; y1: number; x0: number; slope: number; wind: number }[] = []
  for (const contour of contours) {
    for (let i = 0; i < contour.length - 1; i++) {
      const ax = PAD + (contour[i].x - minX) * scale
      const ay = PAD + (maxY - contour[i].y) * scale
      const bx = PAD + (contour[i + 1].x - minX) * scale
      const by = PAD + (maxY - contour[i + 1].y) * scale
      if (ay === by) continue
      const y0 = Math.min(ay, by)
      const y1 = Math.max(ay, by)
      const x0 = ay < by ? ax : bx
      edges.push({ y0, y1, x0, slope: (bx - ax) / (by - ay), wind: by > ay ? 1 : -1 })
    }
  }
  for (let y = 0; y < h; y++) {
    const ys = y + 0.5
    const hits: { x: number; wind: number }[] = []
    for (const edge of edges) {
      if (ys < edge.y0 || ys >= edge.y1) continue
      hits.push({ x: edge.x0 + (ys - edge.y0) * edge.slope, wind: edge.wind })
    }
    hits.sort((a, b) => a.x - b.x)
    let wind = 0
    let cursor = 0
    for (const hit of hits) {
      const next = wind + hit.wind
      if (wind === 0 && next !== 0) cursor = hit.x
      if (wind !== 0 && next === 0) {
        const x0 = Math.max(0, Math.floor(cursor))
        const x1 = Math.min(w, Math.ceil(hit.x))
        for (let x = x0; x < x1; x++) ink[y * w + x] = 1
      }
      wind = next
    }
  }
  if (count(ink) < 8) throw new GeometryError('윤곽을 채우지 못했습니다.')
  return { w, h, ink, minX, maxY, scale, pad: PAD }
}

// 획 윤곽 경로 하나를 격자로 옮긴다. 윤곽이 없거나 너무 작아 채울 수 없으면 null이다(예상된 실패라 던지지 않는다).
export function rasterizeOutline(path: string): Raster | null {
  const contours = flattenContours(path, OUTLINE_FLATNESS)
  if (contours.length === 0) return null
  try {
    return rasterize(contours)
  } catch (error) {
    if (error instanceof GeometryError) return null
    throw error
  }
}

export function pixelPointToFont(raster: Raster, point: Pt): Pt {
  return {
    x: raster.minX + (point.x - raster.pad) / raster.scale,
    y: raster.maxY - (point.y - raster.pad) / raster.scale,
  }
}

export function pixelToFont(raster: Raster, indexOr: number): Pt {
  const x = indexOr % raster.w
  const y = (indexOr / raster.w) | 0
  return {
    x: raster.minX + (x - raster.pad) / raster.scale,
    y: raster.maxY - (y - raster.pad) / raster.scale,
  }
}

export function count(bin: Uint8Array): number {
  let n = 0
  for (let i = 0; i < bin.length; i++) if (bin[i]) n++
  return n
}
