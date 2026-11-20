import { strokeWidthCap } from '../clamp.ts'
import { DEFAULT_STROKE_WIDTH, MIN_STROKE_WIDTH, STROKE_WIDTH_MARGIN } from '../constants.ts'
import { warnOnce } from '../log.ts'
import { flattenContours, pointSegmentDistance, samplePath, type Pt } from '../paths.ts'
import { count, GeometryError, pixelToFont, rasterize, type Raster } from './raster.ts'
import { buildSegments, degrees, pruneSpurs, skelNeighbors, zhangSuen, type Segment } from './skeleton.ts'

// 윤곽에서 중심선과 획 폭을 되찾는다: 래스터 → 골격 → 가장 긴 골격 경로 → 중심선.
const PREPARE_FLATNESS = 1.2
const WIDTH_SAMPLE_FLATNESS = 3
const COVER_SAMPLE_FLATNESS = 2.4
const COVER_NEIGHBOR = 2
const COVER_PADDING = 4

type GlyphModel = {
  raster: Raster
  skeleton: Uint8Array
  deg: Uint8Array
  segments: Segment[]
}

function prepareGlyph(contourPaths: string[]): GlyphModel {
  const contours = contourPaths.flatMap((d) => flattenContours(d, PREPARE_FLATNESS))
  if (contours.length === 0) throw new GeometryError('윤곽이 없습니다.')
  const raster = rasterize(contours)
  const skeleton = zhangSuen(raster.ink, raster.w, raster.h)
  pruneSpurs(skeleton, raster.w, raster.h)
  if (count(skeleton) < 2) throw new GeometryError('획의 중심선을 만들지 못했습니다.')
  const deg = degrees(skeleton, raster.w, raster.h)
  const segments = buildSegments(skeleton, deg, raster.w, raster.h)
  if (segments.length === 0) throw new GeometryError('획의 중심선을 만들지 못했습니다.')
  return { raster, skeleton, deg, segments }
}

export function recoverMedian(path: string, defaultStrokeWidth = DEFAULT_STROKE_WIDTH): { median: Pt[]; width: number; radii: number[] } {
  try {
    const model = prepareGlyph([path])
    const chain = ridgeChain(model)
    if (chain.length < 2) return { median: [], width: defaultStrokeWidth, radii: [] }
    const median = chainMedian(model.raster, orientHeuristic(model.raster, chain))
    const radii = coverRadii(path, median)
    const width = computeOptimalStrokeWidth(path, median, defaultStrokeWidth)
    return { median, width, radii }
  } catch (error) {
    // 입력 모양 탓의 예상된 실패는 조용히 대체값을 쓰고, 그 밖의 오류(코드 결함)는 한 번 알린다.
    if (!(error instanceof GeometryError)) warnOnce('recoverMedian', error)
    return { median: [], width: defaultStrokeWidth, radii: [] }
  }
}

export function computeOptimalStrokeWidth(path: string, median: Pt[], defaultStrokeWidth = DEFAULT_STROKE_WIDTH): number {
  if (median.length < 2 || !path.trim()) return defaultStrokeWidth
  const samples = samplePath(path, WIDTH_SAMPLE_FLATNESS)
  if (samples.length === 0) return defaultStrokeWidth
  let dMax = 0
  for (const s of samples) {
    let minD2 = Infinity
    for (let i = 0; i < median.length - 1; i++) {
      const d = pointSegmentDistance(s, median[i], median[i + 1])
      if (d < minD2) minD2 = d
    }
    if (minD2 > dMax) dMax = minD2
  }
  const computed = Math.ceil(dMax * 2 + STROKE_WIDTH_MARGIN)
  const cap = strokeWidthCap(defaultStrokeWidth)
  return Math.max(MIN_STROKE_WIDTH, Math.min(cap, computed))
}

function ridgeChain(model: GlyphModel): number[] {
  const { skeleton } = model
  const start = skeleton.findIndex((value) => value === 1)
  if (start < 0) return longestTipChain(model)
  const first = farthestSkeleton(model, start)
  const second = farthestSkeleton(model, first.pixel)
  const chain: number[] = []
  let cur = second.pixel
  while (cur >= 0) {
    chain.push(cur)
    if (cur === first.pixel) break
    cur = second.prev[cur]
  }
  return chain.length > 1 ? chain : longestTipChain(model)
}

function farthestSkeleton(model: GlyphModel, source: number): { pixel: number; prev: Int32Array } {
  const { skeleton, raster } = model
  const dist = new Int32Array(skeleton.length).fill(-1)
  const prev = new Int32Array(skeleton.length).fill(-1)
  const queue = [source]
  dist[source] = 0
  let pixel = source
  for (let index = 0; index < queue.length; index++) {
    const cur = queue[index]
    if (dist[cur] > dist[pixel]) pixel = cur
    for (const next of skelNeighbors(skeleton, raster.w, raster.h, cur)) {
      if (dist[next] >= 0) continue
      dist[next] = dist[cur] + 1
      prev[next] = cur
      queue.push(next)
    }
  }
  return { pixel, prev }
}

function longestTipChain(model: GlyphModel): number[] {
  const tips = [...new Set(model.segments.flatMap((seg) => [seg.a, seg.b].filter((pixel) => model.deg[pixel] === 1)))]
  let best: number[] = []
  for (let i = 0; i < tips.length; i++) {
    for (let j = i + 1; j < tips.length; j++) {
      const chain = chainBetweenTips(model, tips[i], tips[j])
      if (chain && chain.length > best.length) best = chain
    }
  }
  if (best.length > 1) return best
  return model.segments.reduce((longest, seg) => (seg.chain.length > longest.length ? seg.chain : longest), [] as number[])
}

function chainBetweenTips(model: GlyphModel, startPx: number, endPx: number): number[] | null {
  const start = model.segments.find((seg) => seg.a === startPx || seg.b === startPx)
  const end = model.segments.find((seg) => seg.a === endPx || seg.b === endPx)
  if (!start || !end) return null
  const chain = chainForShapes(model, start.id, end.id, pixelToFont(model.raster, startPx), pixelToFont(model.raster, endPx))
  if (!chain) return null
  if (chain[chain.length - 1] === startPx) return [...chain].reverse()
  return chain
}

function chainForShapes(model: GlyphModel, startId: number, endId: number, startPt: Pt, endPt: Pt): number[] | null {
  const start = model.segments[startId]
  const end = model.segments[endId]
  if (!start || !end) return null
  if (startId === endId) return orientToClicks(model.raster, start, startPt, endPt)
  if (sharesNode(start, end)) return stitch(model, [startId, endId])
  const ids = shortestSegments(model, startId, endId)
  if (!ids) return null
  return stitch(model, ids)
}

function orientHeuristic(raster: Raster, chain: number[]): number[] {
  const a = pixelToFont(raster, chain[0])
  const b = pixelToFont(raster, chain[chain.length - 1])
  const vertical = Math.abs(b.y - a.y) > Math.abs(b.x - a.x)
  const reverse = vertical ? b.y > a.y : b.x < a.x
  return reverse ? [...chain].reverse() : chain
}

function sharesNode(a: Segment, b: Segment): boolean {
  return a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b
}

function sharedNode(a: Segment, b: Segment): number {
  if (a.a === b.a || a.a === b.b) return a.a
  if (a.b === b.a || a.b === b.b) return a.b
  throw new Error('두 점이 같은 획으로 이어지지 않습니다. 획 위를 다시 찍으세요.')
}

function stitch(model: GlyphModel, ids: number[]): number[] {
  const segs = ids.map((id) => model.segments[id])
  const chain: number[] = []
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    const toward = i === segs.length - 1 ? sharedNode(segs[i - 1], seg) : sharedNode(seg, segs[i + 1])
    const from = i === 0 ? (seg.a === toward ? seg.b : seg.a) : sharedNode(segs[i - 1], seg)
    let part = seg.a === from ? seg.chain : [...seg.chain].reverse()
    if (part[0] !== from) part = [...part].reverse()
    if (chain.length) part = part.slice(1)
    chain.push(...part)
  }
  return chain
}

function orientToClicks(raster: Raster, seg: Segment, startPt: Pt, endPt: Pt): number[] {
  const a = pixelToFont(raster, seg.a)
  const b = pixelToFont(raster, seg.b)
  const startA = Math.hypot(a.x - startPt.x, a.y - startPt.y) <= Math.hypot(b.x - startPt.x, b.y - startPt.y)
  const endA = Math.hypot(a.x - endPt.x, a.y - endPt.y) < Math.hypot(b.x - endPt.x, b.y - endPt.y)
  if (startA !== endA) return startA ? seg.chain : [...seg.chain].reverse()
  const forward = (b.x - a.x) * (endPt.x - startPt.x) + (b.y - a.y) * (endPt.y - startPt.y) >= 0
  return forward ? seg.chain : [...seg.chain].reverse()
}

function shortestSegments(model: GlyphModel, startId: number, endId: number): number[] | null {
  const segs = model.segments
  const start = segs[startId]
  const goal = segs[endId]
  const adj = new Map<number, { id: number; to: number; len: number }[]>()
  const add = (pixel: number, edge: { id: number; to: number; len: number }) => {
    const list = adj.get(pixel)
    if (list) list.push(edge)
    else adj.set(pixel, [edge])
  }
  for (const seg of segs) {
    const len = seg.chain.length
    add(seg.a, { id: seg.id, to: seg.b, len })
    if (seg.a !== seg.b) add(seg.b, { id: seg.id, to: seg.a, len })
  }
  type State = { cost: number; pixel: number; ids: number[] }
  const queue: State[] = [
    { cost: 0, pixel: start.a, ids: [startId] },
    { cost: 0, pixel: start.b, ids: [startId] },
  ]
  const best = new Map<string, number>()
  let found: number[] | null = null
  let foundCost = Infinity
  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost)
    const cur = queue.shift() as State
    if (cur.cost >= foundCost) break
    const key = `${cur.pixel}:${cur.ids[cur.ids.length - 1]}`
    if ((best.get(key) ?? Infinity) <= cur.cost) continue
    best.set(key, cur.cost)
    if (cur.ids[cur.ids.length - 1] !== endId && (cur.pixel === goal.a || cur.pixel === goal.b)) {
      found = [...cur.ids, endId]
      foundCost = cur.cost
      continue
    }
    for (const edge of adj.get(cur.pixel) ?? []) {
      if (cur.ids.includes(edge.id)) continue
      queue.push({ cost: cur.cost + edge.len, pixel: edge.to, ids: [...cur.ids, edge.id] })
    }
  }
  return found
}

function coverRadii(path: string, median: Pt[]): number[] {
  if (median.length === 0) return []
  const samples = samplePath(path, COVER_SAMPLE_FLATNESS)
  const best = median.map(() => 1)
  for (const sample of samples) {
    let nearest = 0
    let nearestD = Infinity
    for (let i = 0; i < median.length; i++) {
      const d = (sample.x - median[i].x) ** 2 + (sample.y - median[i].y) ** 2
      if (d < nearestD) {
        nearestD = d
        nearest = i
      }
    }
    const dist = Math.sqrt(nearestD)
    if (dist > best[nearest]) best[nearest] = dist
  }
  return best.map((_, index) => {
    let radius = 1
    for (let k = Math.max(0, index - COVER_NEIGHBOR); k <= Math.min(best.length - 1, index + COVER_NEIGHBOR); k++) {
      if (best[k] > radius) radius = best[k]
    }
    return radius + COVER_PADDING
  })
}

function chainMedian(raster: Raster, chain: number[]): Pt[] {
  const out: Pt[] = []
  for (let i = 0; i < chain.length; i += 2) out.push(pixelToFont(raster, chain[i]))
  const last = pixelToFont(raster, chain[chain.length - 1])
  const tail = out[out.length - 1]
  if (!tail || tail.x !== last.x || tail.y !== last.y) out.push(last)
  return out
}
