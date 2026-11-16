import { DEFAULT_STROKE_WIDTH, MIN_STROKE_WIDTH, STROKE_WIDTH_CAP_RATIO, STROKE_WIDTH_MARGIN } from './constants.ts'
import { flattenContours, samplePath, type Pt } from './paths.ts'

type Raster = {
  w: number
  h: number
  ink: Uint8Array
  minX: number
  maxY: number
  scale: number
  pad: number
}

type Segment = {
  id: number
  chain: number[]
  a: number
  b: number
  path?: string
  median?: Pt[]
}

export type GlyphModel = {
  raster: Raster
  skeleton: Uint8Array
  dt: Float32Array
  deg: Uint8Array
  segments: Segment[]
}

const PAD = 16
const TARGET = 560
const PREPARE_FLATNESS = 1.2
const KNIFE_FLATNESS = 1.4
const WIDTH_SAMPLE_FLATNESS = 3
const COVER_SAMPLE_FLATNESS = 2.4
const KNIFE_MIN_LENGTH = 4
const OUTLINE_SIMPLIFY = 1.5
const MIN_LOOP_POINTS = 12
const MIN_LOOP_AREA = 20
const COVER_NEIGHBOR = 2
const COVER_PADDING = 4
// 교차부 공유 확장 반경: 기본 획 폭 대비 비율, 최소 픽셀
const COVER_RADIUS_RATIO = 0.42
const COVER_RADIUS_MIN_PX = 4
// 골격 가지치기: 가지 탐색 최대 길이, 이 길이 미만이면 가지로 보고 지우는 기준, 반복 횟수
const SPUR_SCAN_LENGTH = 14
const SPUR_MAX_LENGTH = 12
const SPUR_PASSES = 6
// Chaikin 코너 깎기: 가까운 점/먼 점 가중치
const CHAIKIN_NEAR = 0.75
const CHAIKIN_FAR = 0.25
const N8 = [1, -1, 0, 0, 1, 1, -1, -1]
const N8Y = [0, 0, 1, -1, 1, -1, 1, -1]

export function prepareGlyph(contourPaths: string[]): GlyphModel {
  const contours = contourPaths.flatMap((d) => flattenContours(d, PREPARE_FLATNESS))
  if (contours.length === 0) throw new Error('윤곽이 없습니다.')
  const raster = rasterize(contours)
  const skeleton = zhangSuen(raster.ink, raster.w, raster.h)
  pruneSpurs(skeleton, raster.w, raster.h)
  if (count(skeleton) < 2) throw new Error('획의 중심선을 만들지 못했습니다.')
  const dt = distanceToBackground(raster.ink, raster.w, raster.h)
  const deg = degrees(skeleton, raster.w, raster.h)
  const segments = buildSegments(skeleton, deg, raster.w, raster.h)
  if (segments.length === 0) throw new Error('획의 중심선을 만들지 못했습니다.')
  return { raster, skeleton, dt, deg, segments }
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
  } catch {
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
  const cap = Math.floor(defaultStrokeWidth * STROKE_WIDTH_CAP_RATIO)
  return Math.max(MIN_STROKE_WIDTH, Math.min(cap, computed))
}

function pointSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export function splitStrokeByKnife(strokePath: string, knifeStart: Pt, knifeEnd: Pt): [string, string] | null {
  const contours = flattenContours(strokePath, KNIFE_FLATNESS)
  if (contours.length === 0) return null
  const raster = rasterize(contours)
  const { w, h, ink } = raster
  const leftMask = new Uint8Array(w * h)
  const rightMask = new Uint8Array(w * h)
  const dx = knifeEnd.x - knifeStart.x
  const dy = knifeEnd.y - knifeStart.y
  if (Math.hypot(dx, dy) < KNIFE_MIN_LENGTH) return null
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i]) continue
    const pt = pixelToFont(raster, i)
    const cross = (pt.x - knifeStart.x) * dy - (pt.y - knifeStart.y) * dx
    if (cross >= 0) leftMask[i] = 1
    else rightMask[i] = 1
  }
  const loopsA = traceLoops(leftMask, w, h)
  const loopsB = traceLoops(rightMask, w, h)
  if (loopsA.length === 0 || loopsB.length === 0) return null
  return [
    loopsToPath([rdp(chaikin(loopsA[0]), OUTLINE_SIMPLIFY)], raster),
    loopsToPath([rdp(chaikin(loopsB[0]), OUTLINE_SIMPLIFY)], raster),
  ]
}

export function segmentOutlineByMedians(fullOutlinePaths: string[], medians: Pt[][], defaultWidth = DEFAULT_STROKE_WIDTH): {
  strokes: string[]
  widths: number[]
  coverage: number
} {
  const contours = fullOutlinePaths.flatMap((d) => flattenContours(d, KNIFE_FLATNESS))
  if (contours.length === 0 || medians.length === 0) {
    return { strokes: [], widths: [], coverage: 0 }
  }
  const raster = rasterize(contours)
  const { w, h, ink } = raster
  const strokeMasks = medians.map(() => new Uint8Array(w * h))

  // 1차 브러시 교집합 분할 + 잔여 조각 최근접 중심선 흡수
  let coveredPixels = 0
  let totalInk = 0
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i]) continue
    totalInk++
    const pt = pixelToFont(raster, i)
    let bestIdx = 0
    let bestDist = Infinity
    for (let s = 0; s < medians.length; s++) {
      const med = medians[s]
      for (let j = 0; j < med.length - 1; j++) {
        const d = pointSegmentDistance(pt, med[j], med[j + 1])
        if (d < bestDist) {
          bestDist = d
          bestIdx = s
        }
      }
    }
    strokeMasks[bestIdx][i] = 1
    coveredPixels++
  }

  // 교차점 부근 공유 확장(숨겨진 기필/수필 및 교차부 연속성 확보)
  const radiusPx = Math.max(COVER_RADIUS_MIN_PX, Math.round((defaultWidth * COVER_RADIUS_RATIO) * raster.scale))
  for (let s = 0; s < medians.length; s++) {
    const med = medians[s]
    const mask = strokeMasks[s]
    for (let j = 0; j < med.length - 1; j++) {
      const steps = Math.max(2, Math.ceil(Math.hypot(med[j + 1].x - med[j].x, med[j + 1].y - med[j].y) * raster.scale / 2))
      for (let k = 0; k <= steps; k++) {
        const u = k / steps
        const fx = med[j].x + (med[j + 1].x - med[j].x) * u
        const fy = med[j].y + (med[j + 1].y - med[j].y) * u
        const cx = Math.round(raster.pad + (fx - raster.minX) * raster.scale)
        const cy = Math.round(raster.pad + (raster.maxY - fy) * raster.scale)
        for (let dy = -radiusPx; dy <= radiusPx; dy++) {
          const py = cy + dy
          if (py < 0 || py >= h) continue
          for (let dx = -radiusPx; dx <= radiusPx; dx++) {
            if (dx * dx + dy * dy > radiusPx * radiusPx) continue
            const px = cx + dx
            if (px < 0 || px >= w) continue
            const idx = py * w + px
            if (ink[idx]) mask[idx] = 1
          }
        }
      }
    }
  }

  const strokes: string[] = []
  const widths: number[] = []
  for (let s = 0; s < medians.length; s++) {
    const loops = traceLoops(strokeMasks[s], w, h)
    const path = loops.length > 0 ? loopsToPath([rdp(chaikin(loops[0]), OUTLINE_SIMPLIFY)], raster) : (fullOutlinePaths[s] ?? fullOutlinePaths[0] ?? '')
    strokes.push(path)
    widths.push(computeOptimalStrokeWidth(path, medians[s], defaultWidth))
  }
  return {
    strokes,
    widths,
    coverage: totalInk > 0 ? coveredPixels / totalInk : 1,
  }
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

export function coverRadii(path: string, median: Pt[]): number[] {
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

function rasterize(contours: Pt[][]): Raster {
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
  if (count(ink) < 8) throw new Error('윤곽을 채우지 못했습니다.')
  return { w, h, ink, minX, maxY, scale, pad: PAD }
}

function distanceToBackground(ink: Uint8Array, w: number, h: number): Float32Array {
  const inf = 1e8
  const src = new Float32Array(w * h)
  for (let i = 0; i < src.length; i++) src[i] = ink[i] ? inf : 0
  const tmp = new Float32Array(w * h)
  const dist = new Float32Array(w * h)
  const span = Math.max(w, h)
  const f = new Float32Array(span)
  const d = new Float32Array(span)
  const v = new Int32Array(span)
  const z = new Float64Array(span + 1)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = src[y * w + x]
    edt1(f, w, d, v, z)
    for (let x = 0; x < w; x++) tmp[y * w + x] = d[x]
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = tmp[y * w + x]
    edt1(f, h, d, v, z)
    for (let y = 0; y < h; y++) dist[y * w + x] = Math.sqrt(d[y])
  }
  return dist
}

function edt1(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float64Array) {
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s = parabola(f, q, v[k])
    while (s <= z[k]) {
      k -= 1
      if (k < 0) {
        k = 0
        break
      }
      s = parabola(f, q, v[k])
    }
    k += 1
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k += 1
    const dx = q - v[k]
    d[q] = dx * dx + f[v[k]]
  }
}

function parabola(f: Float32Array, q: number, p: number): number {
  return (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p)
}

function zhangSuen(src: Uint8Array, w: number, h: number): Uint8Array {
  const img = src.slice()
  const offsets = [-w, -w + 1, 1, w + 1, w, w - 1, -1, -w - 1]
  let changed = true
  while (changed) {
    changed = false
    for (let step = 0; step < 2; step++) {
      const drop: number[] = []
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x
          if (!img[i]) continue
          const p = offsets.map((offset) => img[i + offset])
          let bp = 0
          let ap = 0
          for (let k = 0; k < 8; k++) {
            bp += p[k]
            if (!p[k] && p[(k + 1) % 8]) ap++
          }
          if (bp < 2 || bp > 6 || ap !== 1) continue
          if (step === 0) {
            if (p[0] && p[2] && p[4]) continue
            if (p[2] && p[4] && p[6]) continue
          } else {
            if (p[0] && p[2] && p[6]) continue
            if (p[0] && p[4] && p[6]) continue
          }
          drop.push(i)
        }
      }
      if (drop.length) {
        changed = true
        for (const i of drop) img[i] = 0
      }
    }
  }
  return img
}

function pruneSpurs(skeleton: Uint8Array, w: number, h: number) {
  for (let pass = 0; pass < SPUR_PASSES; pass++) {
    const deg = degrees(skeleton, w, h)
    let changed = false
    for (let i = 0; i < skeleton.length; i++) {
      if (!skeleton[i] || deg[i] !== 1) continue
      const chain = [i]
      let prev = -1
      let cur = i
      while (chain.length < SPUR_SCAN_LENGTH) {
        const next = skelNeighbors(skeleton, w, h, cur).find((pixel) => pixel !== prev)
        if (next === undefined) break
        chain.push(next)
        prev = cur
        cur = next
        if (deg[cur] !== 2) break
      }
      if (deg[cur] >= 3 && chain.length < SPUR_MAX_LENGTH) {
        for (const pixel of chain) if (pixel !== cur) skeleton[pixel] = 0
        changed = true
      }
    }
    if (!changed) break
  }
}

function degrees(skeleton: Uint8Array, w: number, h: number): Uint8Array {
  const deg = new Uint8Array(w * h)
  for (let i = 0; i < skeleton.length; i++) {
    if (skeleton[i]) deg[i] = skelNeighbors(skeleton, w, h, i).length
  }
  return deg
}

function buildSegments(skeleton: Uint8Array, deg: Uint8Array, w: number, h: number): Segment[] {
  const used = new Set<string>()
  const segments: Segment[] = []
  const nodes: number[] = []
  for (let i = 0; i < skeleton.length; i++) {
    if (skeleton[i] && deg[i] !== 2) nodes.push(i)
  }
  const push = (chain: number[]) => {
    if (chain.length < 2) return
    for (let i = 1; i < chain.length; i++) used.add(edgeKey(chain[i - 1], chain[i]))
    segments.push({ id: segments.length, chain, a: chain[0], b: chain[chain.length - 1] })
  }
  for (const node of nodes) {
    for (const next of skelNeighbors(skeleton, w, h, node)) {
      if (used.has(edgeKey(node, next))) continue
      const chain = [node]
      let prev = node
      let cur = next
      const seen = new Set([node])
      while (!seen.has(cur)) {
        chain.push(cur)
        seen.add(cur)
        if (deg[cur] !== 2) break
        const onward = skelNeighbors(skeleton, w, h, cur).find((pixel) => pixel !== prev)
        if (onward === undefined) break
        prev = cur
        cur = onward
      }
      push(chain)
    }
  }
  if (segments.length === 0) {
    const start = skeleton.findIndex((value) => value === 1)
    if (start >= 0) {
      const chain = [start]
      let prev = -1
      let cur = start
      for (let guard = 0; guard < skeleton.length; guard++) {
        const onward = skelNeighbors(skeleton, w, h, cur).find((pixel) => pixel !== prev && !chain.includes(pixel))
        if (onward === undefined) break
        prev = cur
        cur = onward
        chain.push(cur)
      }
      push(chain)
    }
  }
  return segments
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`
}

function skelNeighbors(skeleton: Uint8Array, w: number, h: number, i: number): number[] {
  const x = i % w
  const y = (i / w) | 0
  const found: number[] = []
  for (let k = 0; k < 8; k++) {
    const nx = x + N8[k]
    const ny = y + N8Y[k]
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
    const ni = ny * w + nx
    if (skeleton[ni]) found.push(ni)
  }
  return found
}

const MOORE = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
]

function traceLoops(mask: Uint8Array, w: number, h: number): Pt[][] {
  const used = new Uint8Array(w * h)
  const loops: { pts: Pt[]; area: number }[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!mask[i] || used[i]) continue
      if (x > 0 && mask[i - 1]) continue
      const pts = moore(mask, w, h, x, y)
      if (pts.length < MIN_LOOP_POINTS) continue
      for (const point of pts) used[point.y * w + point.x] = 1
      const area = Math.abs(shoelace(pts))
      if (area > MIN_LOOP_AREA) loops.push({ pts, area })
    }
  }
  loops.sort((a, b) => b.area - a.area)
  if (loops.length === 0) return []
  return [loops[0].pts]
}

function moore(mask: Uint8Array, w: number, h: number, sx: number, sy: number): Pt[] {
  const pts: Pt[] = []
  let x = sx
  let y = sy
  let dir = 6
  const limit = w * h
  for (let guard = 0; guard < limit; guard++) {
    pts.push({ x, y })
    let found = false
    for (let turn = 0; turn < 8; turn++) {
      const nd = (dir + turn) % 8
      const nx = x + MOORE[nd][0]
      const ny = y + MOORE[nd][1]
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      if (!mask[ny * w + nx]) continue
      x = nx
      y = ny
      dir = (nd + 6) % 8
      found = true
      break
    }
    if (!found) break
    if (x === sx && y === sy) break
  }
  return pts
}

function chaikin(points: Pt[]): Pt[] {
  if (points.length < 4) return points
  const out: Pt[] = []
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    out.push({ x: a.x * CHAIKIN_NEAR + b.x * CHAIKIN_FAR, y: a.y * CHAIKIN_NEAR + b.y * CHAIKIN_FAR })
    out.push({ x: a.x * CHAIKIN_FAR + b.x * CHAIKIN_NEAR, y: a.y * CHAIKIN_FAR + b.y * CHAIKIN_NEAR })
  }
  return out
}

function shoelace(pts: Pt[]): number {
  let sum = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

function rdp(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return points
  const closed = points[0].x === points[points.length - 1].x && points[0].y === points[points.length - 1].y
  const body = closed ? points.slice(0, -1) : points
  if (body.length < 3) return points
  let maxD = 0
  let index = 0
  const a = body[0]
  const b = body[body.length - 1]
  for (let i = 1; i < body.length - 1; i++) {
    const d = pointLineDistance(body[i], a, b)
    if (d > maxD) {
      maxD = d
      index = i
    }
  }
  if (maxD <= epsilon) return closed ? [a, b, a] : [a, b]
  const left = rdp(body.slice(0, index + 1), epsilon)
  const right = rdp(body.slice(index), epsilon)
  const merged = left.slice(0, -1).concat(right)
  return closed ? [...merged, merged[0]] : merged
}

export function simplifyPolyline(points: Pt[], tolerance: number): Pt[] {
  return rdp(points, tolerance)
}

function pointLineDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len
}

function loopsToPath(loops: Pt[][], raster: Raster): string {
  return loops
    .map((loop) => {
      const head = pixelPointToFont(raster, loop[0])
      let d = `M${Math.round(head.x)} ${Math.round(head.y)}`
      for (let i = 1; i < loop.length; i++) {
        const point = pixelPointToFont(raster, loop[i])
        d += `L${Math.round(point.x)} ${Math.round(point.y)}`
      }
      return `${d}Z`
    })
    .join(' ')
}

function pixelPointToFont(raster: Raster, point: Pt): Pt {
  return {
    x: raster.minX + (point.x - raster.pad) / raster.scale,
    y: raster.maxY - (point.y - raster.pad) / raster.scale,
  }
}

function pixelToFont(raster: Raster, indexOr: number): Pt {
  const x = indexOr % raster.w
  const y = (indexOr / raster.w) | 0
  return {
    x: raster.minX + (x - raster.pad) / raster.scale,
    y: raster.maxY - (y - raster.pad) / raster.scale,
  }
}

function count(bin: Uint8Array): number {
  let n = 0
  for (let i = 0; i < bin.length; i++) if (bin[i]) n++
  return n
}
