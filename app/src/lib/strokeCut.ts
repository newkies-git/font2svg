import { COORD_DECIMALS, COORD_ROUND, DEFAULT_STROKE_WIDTH, MIN_STROKE_WIDTH, STROKE_WIDTH_CAP_RATIO, STROKE_WIDTH_MARGIN } from './constants.ts'
import { flattenContours, samplePath, type Pt } from './paths.ts'

export type StrokeGeometry = {
  path: string
  median: Pt[]
  width: number
  radii: number[]
}

export type ShapeChoice = {
  id: number
  path: string
  median: Pt[]
}

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

export type Region = { minX: number; minY: number; maxX: number; maxY: number }

export function shapesInRegion(model: GlyphModel, region: Region): ShapeChoice[] {
  const { raster, skeleton } = model
  const counts = new Map<number, number>()
  for (let i = 0; i < skeleton.length; i++) {
    if (!skeleton[i]) continue
    const point = pixelToFont(raster, i)
    if (point.x < region.minX || point.x > region.maxX || point.y < region.minY || point.y > region.maxY) continue
    for (const seg of segmentsThrough(model, i)) counts.set(seg.id, (counts.get(seg.id) ?? 0) + 1)
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
  if (ranked.length === 0) return []
  const meaningful = ranked.filter((item) => item[1] > 1)
  const pool = meaningful.length > 0 ? meaningful : ranked
  const best = pool[0][1]
  const kept = pool.filter((item) => item[1] * 3 >= best)
  return kept.flatMap(([id]) => {
    const seg = model.segments[id]
    const preview = ensurePreview(model, seg)
    return preview ? [{ id: seg.id, path: preview.path, median: preview.median }] : []
  })
}

export function extractFromShapes(model: GlyphModel, startId: number, endId: number, startPt: Pt, endPt: Pt): StrokeGeometry {
  const chain = chainForShapes(model, startId, endId, startPt, endPt)
  if (!chain || chain.length < 2) throw new Error('두 점이 같은 획으로 이어지지 않습니다. 획 위를 다시 찍으세요.')
  return geometryFromChain(model, chain)
}

export function recoverMedian(path: string, defaultStrokeWidth = DEFAULT_STROKE_WIDTH): { median: Pt[]; width: number; radii: number[] } {
  try {
    const model = prepareGlyph([path])
    const chain = longestTipChain(model)
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
  const radiusPx = Math.max(4, Math.round((defaultWidth * 0.42) * raster.scale))
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

function geometryFromChain(model: GlyphModel, chain: number[]): StrokeGeometry {
  const raw = chain.map((index) => model.dt[index])
  const tip = tipZone(model, chain, bodyRadius(raw))
  const radii = smoothRadii(clampRadii(raw, tip))
  const region = fillStrokeTips(model, chain, ribbon(model, chain, radii), tip)
  const loops = traceLoops(region, model.raster.w, model.raster.h)
  if (loops.length === 0) throw new Error('이 구간의 획 윤곽을 만들지 못했습니다.')
  const median = chainMedian(model.raster, chain)
  const path = outlinePath(loops[0], model, chain, radii)
  return {
    path,
    median,
    width: ribbonWidth(radii, model.raster.scale),
    radii: coverRadii(path, median),
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

function ensurePreview(model: GlyphModel, seg: Segment): { path: string; median: Pt[] } | null {
  if (seg.path && seg.median) return { path: seg.path, median: seg.median }
  try {
    const geometry = geometryFromChain(model, seg.chain)
    seg.path = geometry.path
    seg.median = geometry.median
    return { path: seg.path, median: seg.median }
  } catch {
    return null
  }
}

function segmentsThrough(model: GlyphModel, pixel: number): Segment[] {
  return model.segments.filter((seg) => seg.chain.includes(pixel))
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

function bodyRadius(raw: number[]): number {
  const finite = raw.map((value) => (Number.isFinite(value) && value > 0 ? value : 1))
  const sorted = [...finite].sort((a, b) => a - b)
  const mid = sorted[Math.floor(sorted.length / 2)] || 1
  const body = finite.filter((value) => value <= mid * 1.2)
  return median(body.length ? body : finite)
}

function clampRadii(raw: number[], tip: boolean[]): number[] {
  const finite = raw.map((value) => (Number.isFinite(value) && value > 0 ? value : 1))
  const base = bodyRadius(finite)
  return finite.map((value, index) => (tip[index] || value <= base * 1.25 ? value : base))
}

function tipZone(model: GlyphModel, chain: number[], base: number): boolean[] {
  const zone = chain.map(() => false)
  const onChain = new Uint8Array(model.raster.w * model.raster.h)
  for (const index of chain) onChain[index] = 1
  const reach = Math.ceil(Math.max(8, base * 1.4))
  const limit = Math.ceil(Math.max(12, base * 3.2))
  const mark = (fromStart: boolean) => {
    for (let step = 0; step < chain.length && step < limit; step++) {
      const index = fromStart ? step : chain.length - 1 - step
      if (seesForeignSkeleton(model, onChain, chain[index], reach)) break
      zone[index] = true
    }
  }
  mark(true)
  mark(false)
  return zone
}

function seesForeignSkeleton(model: GlyphModel, onChain: Uint8Array, start: number, reach: number): boolean {
  const { skeleton, raster } = model
  const w = raster.w
  const h = raster.h
  const seen = new Uint8Array(w * h)
  const dist = new Int16Array(w * h)
  const queue = [start]
  seen[start] = 1
  for (let q = 0; q < queue.length; q++) {
    const index = queue[q]
    if (!onChain[index]) return true
    if (dist[index] >= reach) continue
    const x = index % w
    const y = (index / w) | 0
    for (let k = 0; k < 8; k++) {
      const nx = x + N8[k]
      const ny = y + N8Y[k]
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const next = ny * w + nx
      if (seen[next] || !skeleton[next]) continue
      seen[next] = 1
      dist[next] = dist[index] + 1
      queue.push(next)
    }
  }
  return false
}

function fillStrokeTips(model: GlyphModel, chain: number[], region: Uint8Array, tip: boolean[]): Uint8Array {
  if (!tip.some(Boolean)) return region
  const { raster, skeleton } = model
  const { w, h, ink } = raster
  const nearest = nearestSkeleton(ink, skeleton, w, h)
  const onChain = new Uint8Array(w * h)
  for (const index of chain) onChain[index] = 1
  const tipPixel = new Uint8Array(w * h)
  for (let i = 0; i < chain.length; i++) if (tip[i]) tipPixel[chain[i]] = 1
  absorbShortBranches(model, onChain, tipPixel, bodyRadius(chain.map((index) => model.dt[index])))
  const out = region.slice()
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i] || out[i]) continue
    const owner = nearest[i]
    if (owner >= 0 && tipPixel[owner]) out[i] = 1
  }
  return out
}

function absorbShortBranches(model: GlyphModel, onChain: Uint8Array, tipPixel: Uint8Array, base: number) {
  const { skeleton, raster } = model
  const w = raster.w
  const h = raster.h
  const limit = Math.ceil(Math.max(10, base * 3.5))
  const seen = new Uint8Array(w * h)
  for (let i = 0; i < tipPixel.length; i++) {
    if (!tipPixel[i]) continue
    const x = i % w
    const y = (i / w) | 0
    for (let k = 0; k < 8; k++) {
      const nx = x + N8[k]
      const ny = y + N8Y[k]
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const seed = ny * w + nx
      if (!skeleton[seed] || onChain[seed] || seen[seed]) continue
      const branch = [seed]
      const queue = [seed]
      seen[seed] = 1
      for (let q = 0; q < queue.length; q++) {
        const index = queue[q]
        const sx = index % w
        const sy = (index / w) | 0
        for (let n = 0; n < 8; n++) {
          const ax = sx + N8[n]
          const ay = sy + N8Y[n]
          if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue
          const next = ay * w + ax
          if (!skeleton[next] || onChain[next] || seen[next]) continue
          seen[next] = 1
          branch.push(next)
          queue.push(next)
        }
      }
      if (branch.length <= limit * 3) for (const index of branch) tipPixel[index] = 1
    }
  }
}

function nearestSkeleton(ink: Uint8Array, skeleton: Uint8Array, w: number, h: number): Int32Array {
  const nearest = new Int32Array(w * h).fill(-1)
  const dist = new Int32Array(w * h).fill(-1)
  const queue: number[] = []
  for (let i = 0; i < skeleton.length; i++) {
    if (!skeleton[i]) continue
    nearest[i] = i
    dist[i] = 0
    queue.push(i)
  }
  for (let q = 0; q < queue.length; q++) {
    const index = queue[q]
    const x = index % w
    const y = (index / w) | 0
    for (let k = 0; k < 8; k++) {
      const nx = x + N8[k]
      const ny = y + N8Y[k]
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const next = ny * w + nx
      if (!ink[next] || dist[next] !== -1) continue
      dist[next] = dist[index] + 1
      nearest[next] = nearest[index]
      queue.push(next)
    }
  }
  return nearest
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

function smoothRadii(values: number[]): number[] {
  return values.map((value, index) => {
    const left = values[Math.max(0, index - 2)]
    const right = values[Math.min(values.length - 1, index + 2)]
    return Math.max(1.5, (left + value + right) / 3)
  })
}

function ribbon(model: GlyphModel, chain: number[], radii: number[]): Uint8Array {
  const { raster } = model
  const { w, h, ink } = raster
  const region = new Uint8Array(w * h)
  for (let i = 0; i < chain.length; i++) {
    const cx = chain[i] % w
    const cy = (chain[i] / w) | 0
    const radius = radii[i] + 1.35
    const reach = Math.ceil(radius)
    for (let dy = -reach; dy <= reach; dy++) {
      const y = cy + dy
      if (y < 0 || y >= h) continue
      for (let dx = -reach; dx <= reach; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue
        const x = cx + dx
        if (x < 0 || x >= w) continue
        const index = y * w + x
        if (ink[index]) region[index] = 1
      }
    }
  }
  const closed = region.slice()
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const index = y * w + x
      if (!ink[index] || region[index]) continue
      for (let k = 0; k < 8; k++) {
        const nx = x + N8[k]
        const ny = y + N8Y[k]
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        if (region[ny * w + nx]) {
          closed[index] = 1
          break
        }
      }
    }
  }
  return closed
}

function ribbonWidth(radii: number[], scale: number): number {
  let max = 1
  for (const radius of radii) if (radius > max) max = radius
  return (max * 2 + 4) / scale
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
  for (let pass = 0; pass < 6; pass++) {
    const deg = degrees(skeleton, w, h)
    let changed = false
    for (let i = 0; i < skeleton.length; i++) {
      if (!skeleton[i] || deg[i] !== 1) continue
      const chain = [i]
      let prev = -1
      let cur = i
      while (chain.length < 14) {
        const next = skelNeighbors(skeleton, w, h, cur).find((pixel) => pixel !== prev)
        if (next === undefined) break
        chain.push(next)
        prev = cur
        cur = next
        if (deg[cur] !== 2) break
      }
      if (deg[cur] >= 3 && chain.length < 12) {
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
    out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 })
    out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 })
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

function pointLineDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len
}

function outlinePath(pixelPts: Pt[], model: GlyphModel, chain: number[], radii: number[]): string {
  const smooth = chaikin(pixelPts)
  const raster = model.raster
  const fontPts = smooth.map((point) => pixelPointToFont(raster, point))
  let flags = closeFlagGaps(markCrossing(fontPts, model, chain, radii), 64)
  if (!flags.some(Boolean)) return loopsToPath([rdp(smooth, 1.6)], raster)
  const start = flags.findIndex((flag) => !flag)
  const orderedPx = start > 0 ? rotate(smooth, start) : smooth
  const ordered = start > 0 ? rotate(fontPts, start) : fontPts
  flags = start > 0 ? rotate(flags, start) : flags
  const body = median(radii) / raster.scale
  const parts: string[] = [`M${fmt(ordered[0].x)} ${fmt(ordered[0].y)}`]
  const n = ordered.length
  let i = 0
  while (i < n) {
    let j = i + 1
    while (j < n && !flags[j]) j++
    const line = rdp(orderedPx.slice(i, j), 1.6).map((point) => pixelPointToFont(raster, point))
    for (let k = 1; k < line.length; k++) parts.push(`L${fmt(line[k].x)} ${fmt(line[k].y)}`)
    if (j >= n) break
    let k = j
    while (k < n && flags[k]) k++
    const from = ordered[j - 1]
    const to = k < n ? ordered[k] : ordered[0]
    const prev = ordered[Math.max(0, j - 2)]
    const after = k < n ? ordered[Math.min(n - 1, k + 1)] : ordered[Math.min(1, n - 1)]
    const curve = crossingCubic(from, to, prev, after, body * 0.18)
    const mid = cubicPoint(from, curve.c1, curve.c2, to, 0.5)
    let near = Math.hypot(to.x - mid.x, to.y - mid.y)
    for (let t = Math.max(0, j - 1); t < n && t <= k; t++) {
      near = Math.min(near, Math.hypot(ordered[t].x - mid.x, ordered[t].y - mid.y))
    }
    if (near > body * 1.25) {
      const fallback = rdp(orderedPx.slice(j - 1, Math.min(n, k + 1)), 1.6).map((point) => pixelPointToFont(raster, point))
      for (let t = 1; t < fallback.length; t++) parts.push(`L${fmt(fallback[t].x)} ${fmt(fallback[t].y)}`)
    } else {
      parts.push(`C${fmt(curve.c1.x)} ${fmt(curve.c1.y)} ${fmt(curve.c2.x)} ${fmt(curve.c2.y)} ${fmt(to.x)} ${fmt(to.y)}`)
    }
    if (k >= n) break
    i = k
  }
  return `${parts.join('')}Z`
}

function markCrossing(fontPts: Pt[], model: GlyphModel, chain: number[], radii: number[]): boolean[] {
  const flags = crossingFlags(model, chain, radii)
  const samples: { x: number; y: number; cross: boolean }[] = []
  for (let i = 0; i < chain.length; i += 2) {
    const point = pixelToFont(model.raster, chain[i])
    samples.push({
      x: point.x,
      y: point.y,
      cross: flags[i] || flags[Math.min(chain.length - 1, i + 1)],
    })
  }
  if (samples.length === 0) return fontPts.map(() => false)
  return fontPts.map((point) => {
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < samples.length; i++) {
      const d = (samples[i].x - point.x) ** 2 + (samples[i].y - point.y) ** 2
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    return samples[best].cross
  })
}

function closeFlagGaps(flags: boolean[], gap: number): boolean[] {
  const out = flags.slice()
  let i = 0
  while (i < out.length) {
    if (out[i]) {
      i++
      continue
    }
    let j = i
    while (j < out.length && !out[j]) j++
    if (i > 0 && out[i - 1] && j < out.length && out[j] && j - i <= gap) {
      for (let k = i; k < j; k++) out[k] = true
    }
    i = j
  }
  return out
}

function crossingFlags(model: GlyphModel, chain: number[], radii: number[]): boolean[] {
  const reach = Math.ceil(Math.max(8, median(radii) * 2))
  const margin = reach
  const flags = chain.map((index, i) => model.deg[index] >= 3 && i > margin && i < chain.length - 1 - margin)
  const out = flags.slice()
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) continue
    const from = Math.max(margin, i - reach)
    const to = Math.min(flags.length - 1 - margin, i + reach)
    for (let j = from; j <= to; j++) out[j] = true
  }
  return out
}

function crossingCubic(from: Pt, to: Pt, prev: Pt, next: Pt, bow: number): { c1: Pt; c2: Pt } {
  const chord = { x: to.x - from.x, y: to.y - from.y }
  const dist = Math.hypot(chord.x, chord.y) || 1
  const unitChord = { x: chord.x / dist, y: chord.y / dist }
  let t0 = unitOf(from.x - prev.x, from.y - prev.y)
  let t1 = unitOf(next.x - to.x, next.y - to.y)
  if (t0.x * unitChord.x + t0.y * unitChord.y < 0.35) t0 = unitChord
  if (t1.x * unitChord.x + t1.y * unitChord.y < 0.35) t1 = unitChord
  return {
    c1: clampToChord({ x: from.x + (t0.x * dist) / 3, y: from.y + (t0.y * dist) / 3 }, from, to, bow),
    c2: clampToChord({ x: to.x - (t1.x * dist) / 3, y: to.y - (t1.y * dist) / 3 }, from, to, bow),
  }
}

function clampToChord(control: Pt, from: Pt, to: Pt, limit: number): Pt {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len2 = dx * dx + dy * dy || 1
  const t = ((control.x - from.x) * dx + (control.y - from.y) * dy) / len2
  const proj = { x: from.x + dx * t, y: from.y + dy * t }
  let ox = control.x - proj.x
  let oy = control.y - proj.y
  const offset = Math.hypot(ox, oy)
  if (offset > limit && offset > 0) {
    ox *= limit / offset
    oy *= limit / offset
  }
  return { x: proj.x + ox, y: proj.y + oy }
}

function cubicPoint(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t
  const b0 = u * u * u
  const b1 = 3 * u * u * t
  const b2 = 3 * u * t * t
  const b3 = t * t * t
  return {
    x: p0.x * b0 + c1.x * b1 + c2.x * b2 + p1.x * b3,
    y: p0.y * b0 + c1.y * b1 + c2.y * b2 + p1.y * b3,
  }
}

function unitOf(x: number, y: number): Pt {
  const len = Math.hypot(x, y)
  if (len < 1e-6) return { x: 0, y: 0 }
  return { x: x / len, y: y / len }
}

function rotate<T>(items: T[], start: number): T[] {
  return items.slice(start).concat(items.slice(0, start))
}

function fmt(value: number): string {
  const rounded = Math.round(value * COORD_ROUND) / COORD_ROUND
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(COORD_DECIMALS)
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

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] || 1
}

function count(bin: Uint8Array): number {
  let n = 0
  for (let i = 0; i < bin.length; i++) if (bin[i]) n++
  return n
}
