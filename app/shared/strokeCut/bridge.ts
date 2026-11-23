import { fitOpenPolyline } from './curveFit.ts'
import { flattenContours, pointSegmentDistance, polygonArea, round1, type Pt } from '../paths.ts'
import {
  buildOverlapCubic,
  chordNearInk,
  isStrokeEndGap,
  measureMedianWidths,
  nearestPartnerIndex,
  targetOverlapDepth,
  type EndOverlapRange,
} from './overlap.ts'
import { GeometryError, rasterize, type Raster } from './raster.ts'

// 외곽선을 다시 찍는 간격. 모서리에서 획 배정이 한 점에 몰리지 않게 한다.
const SAMPLE_STEP = 4
// 이보다 크게 꺾이면 그 획의 변이 다른 획 쪽으로 돌아선 모서리다. cos(60°).
const SHARP_TURN = 0.5

type Run = { from: number; to: number; full?: boolean }
type BridgeOptions = {
  raster?: Raster
  endOverlap?: EndOverlapRange
}
type OverlapContext = {
  raster: Raster
  strokeWidths: number[]
  range: EndOverlapRange
}

// 글자 윤곽의 점을 가장 가까운 중심선에 배정하고, 한 획의 외곽선이 끊긴 끝점과 끝점을 베지어로 잇는다.
// 끊긴 간격이 maxGap보다 길거나 그 획의 외곽선 점이 없으면 null. 호출한 쪽은 그때 격자 윤곽을 쓴다.
// 중심선이 실제로 만나는 곳. 스치기만 하는 획은 교차로 보지 않는다.
const CROSSING_APPROACH = 24

function createOverlapContext(
  contours: Pt[][],
  medians: Pt[][],
  options?: BridgeOptions,
): OverlapContext | null {
  const range = options?.endOverlap
  if (!range || range.max <= 0 || contours.length === 0) return null
  let raster = options?.raster
  if (!raster) {
    try {
      raster = rasterize(contours)
    } catch (error) {
      if (error instanceof GeometryError) return null
      throw error
    }
  }
  return {
    raster,
    strokeWidths: measureMedianWidths(raster, medians),
    range,
  }
}

export function outlineByContourBridges(
  contours: Pt[][],
  medians: Pt[][],
  maxGap: number,
  options?: BridgeOptions,
): (string | null)[] {
  const partners = crossingPartners(medians)
  // 교차하는 다른 획의 중심선에 이보다 가까운, 구간의 한가운데 점은 교차 벽이다. 끝점은 남긴다.
  const wall = maxGap * 0.2
  const overlap = createOverlapContext(contours, medians, options)
  return medians.map((_, stroke) => pathForStroke(contours, medians, stroke, maxGap, partners, wall, overlap))
}

// 찍은 점(끝점, 중간점)으로 기존 윤곽의 짧은 쪽을 베지어로 바꾼다. 윤곽이 없으면 null.
export function spliceOutlineBridge(outline: string, marks: Pt[]): string | null {
  const loops = flattenContours(outline, 1.2).map(openRing).filter((ring) => ring.length >= 3)
  if (loops.length === 0 || marks.length < 2) return null
  const ring = loops.reduce((best, loop) => (loop.length > best.length ? loop : best))
  if (ring.length < 3) return null
  const start = locate(ring, marks[0])
  const end = locate(ring, marks[marks.length - 1])
  if (Math.hypot(start.point.x - end.point.x, start.point.y - end.point.y) < 1) return null
  const forward = walk(ring, start, end)
  const back = walk(ring, end, start)
  const shorter = lengthOf(forward) <= lengthOf(back) ? forward : back
  const kept = shorter === forward ? back : forward
  const through = dedupe([kept[kept.length - 1], ...marks, kept[0]])
  const cmds = [`M ${fmt(kept[0])}`]
  for (let i = 1; i < kept.length; i++) cmds.push(`L ${fmt(kept[i])}`)
  appendSpline(cmds, through)
  cmds.push('Z')
  return cmds.join(' ')
}

function pathForStroke(
  contours: Pt[][],
  medians: Pt[][],
  stroke: number,
  maxGap: number,
  partners: number[][],
  wall: number,
  overlap: OverlapContext | null,
): string | null {
  const subpaths: string[] = []
  for (const contour of contours) {
    const ring = resample(contour)
    if (ring.length < 3) continue
    const labels = smooth(ring.map((point) => nearest(point, medians)))
    const runs = runsOf(labels, stroke)
    if (runs.length === 0) continue
    if (runs.length === 1 && runs[0].full) {
      // 원본 경로 문자열과 같으면 분할 실패로 버려지므로, 같은 외곽선 위의 점을 다시 찍어 만든다.
      subpaths.push(closedPolyline(ring))
      continue
    }
    const bridged = bridgeRuns(ring, labels, runs, maxGap, medians, stroke, partners[stroke], wall, overlap)
    if (!bridged) return null
    subpaths.push(bridged)
  }
  return subpaths.length > 0 ? subpaths.join(' ') : null
}

function silhouetteEndpoint(
  ring: Pt[],
  start: number,
  limit: number,
  step: number,
  adjLabel: number,
  medians: Pt[][],
  owner: number,
  partners: number[],
  wall: number,
  overlap: OverlapContext | null,
): number {
  if (!overlap || adjLabel === owner) {
    return walkToSilhouette(ring, start, limit, step, medians, owner, partners, wall)
  }
  const activePartners = partners.includes(adjLabel) ? partners : [...partners, adjLabel]
  const activeWall = Math.max(wall, (overlap.strokeWidths[adjLabel] ?? 0) * 0.75)
  return walkToSilhouette(ring, start, limit, step, medians, owner, activePartners, activeWall)
}

function overlapBridgeCubic(
  a: Pt,
  b: Pt,
  chordLen: number,
  ringArea: number,
  medians: Pt[][],
  owner: number,
  overlap: OverlapContext,
): string | null {
  const nOut = ringArea > 0
    ? { x: (b.y - a.y) / chordLen, y: -(b.x - a.x) / chordLen }
    : { x: -(b.y - a.y) / chordLen, y: (b.x - a.x) / chordLen }
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  if (!isStrokeEndGap(mid, chordLen, nOut, medians[owner], overlap.strokeWidths[owner] ?? 0)) return null
  const probe = { x: mid.x + nOut.x * 6, y: mid.y + nOut.y * 6 }
  const partner = nearestPartnerIndex(probe, medians, owner)
  const partnerWidth = partner >= 0 ? (overlap.strokeWidths[partner] ?? 0) : 0
  const { target } = targetOverlapDepth(overlap.raster, mid, nOut, partnerWidth, overlap.range)
  const ctrl = buildOverlapCubic(a, b, nOut, target, overlap.raster)
  return ctrl ? `C ${fmt(ctrl.c1)} ${fmt(ctrl.c2)} ${fmt(b)}` : null
}

function bridgeRuns(
  ring: Pt[],
  labels: number[],
  runs: Run[],
  maxGap: number,
  medians: Pt[][],
  owner: number,
  partners: number[],
  wall: number,
  overlap: OverlapContext | null,
): string | null {
  const n = ring.length
  const cut = runs.map((run, r) => {
    const next = runs[(r + 1) % runs.length]
    const leaveAdj = labels[(run.to + 1) % n]
    const enterAdj = labels[(next.from - 1 + n) % n]
    return {
      leave: silhouetteEndpoint(ring, run.to, run.from, -1, leaveAdj, medians, owner, partners, wall, overlap),
      enter: silhouetteEndpoint(ring, next.from, next.to, 1, enterAdj, medians, owner, partners, wall, overlap),
    }
  })
  // 양쪽으로 늘린 끝이 구간 안에서 엇갈리면 그 구간은 원래 끝점을 쓴다.
  for (let r = 0; r < runs.length; r++) {
    const run = runs[r]
    const prev = (r - 1 + runs.length) % runs.length
    const enter = cut[prev].enter
    const leave = cut[r].leave
    const runSpan = (run.to - run.from + n) % n
    const drawSpan = (leave - enter + n) % n
    if (enter !== leave && drawSpan > runSpan) {
      cut[prev].enter = run.from
      cut[r].leave = run.to
    }
  }
  for (let r = 0; r < runs.length; r++) {
    const a = ring[cut[r].leave]
    const b = ring[cut[r].enter]
    if (Math.hypot(b.x - a.x, b.y - a.y) > maxGap) return null
    if (overlap && !chordNearInk(overlap.raster, a, b)) return null
  }
  const ringArea = overlap ? polygonArea(ring) : 0
  const cmds = [`M ${fmt(ring[cut[runs.length - 1].enter])}`]
  for (let r = 0; r < runs.length; r++) {
    const leave = cut[r].leave
    let i = cut[(r - 1 + runs.length) % runs.length].enter
    const walked = [ring[i]]
    while (i !== leave) {
      i = (i + 1) % n
      walked.push(ring[i])
    }
    cmds.push(fitOpenPolyline(walked))
    const a = ring[leave]
    const b = ring[cut[r].enter]
    const chordLen = Math.hypot(b.x - a.x, b.y - a.y)
    if (chordLen < 0.5) continue
    const cubic = overlap
      ? overlapBridgeCubic(a, b, chordLen, ringArea, medians, owner, overlap)
      : null
    cmds.push(cubic ?? chordCubic(a, b))
  }
  cmds.push('Z')
  return cmds.join(' ')
}

// 끊긴 자리가 다른 획의 옆면에 있으면, 그 획의 변이 꺾이는 모서리까지 끝점을 옮긴다.
function walkToSilhouette(
  ring: Pt[],
  start: number,
  limit: number,
  step: number,
  medians: Pt[][],
  owner: number,
  partners: number[],
  wall: number,
): number {
  if (partners.length === 0 || sharpTurn(ring, start)) return start
  const n = ring.length
  let i = start
  while (i !== limit && nearPartner(ring[i], medians, partners, wall) && followsPartner(ring, i, medians, owner, partners) && !sharpTurn(ring, i)) {
    const next = (i + step + n) % n
    if (next === limit) return sharpTurn(ring, next) ? next : start
    i = next
    if (sharpTurn(ring, i)) return i
  }
  return i
}

// 외곽선이 자기 획보다 상대 획의 중심선 방향으로 놓여 있으면, 그 점은 상대 획의 옆면이다.
function followsPartner(ring: Pt[], index: number, medians: Pt[][], owner: number, partners: number[]): boolean {
  const n = ring.length
  const a = ring[(index - 1 + n) % n]
  const c = ring[(index + 1) % n]
  const dx = c.x - a.x
  const dy = c.y - a.y
  const len = Math.hypot(dx, dy)
  if (len < 0.5) return false
  const align = (median: Pt[]) => {
    const dir = closestDirection(ring[index], median)
    const dlen = Math.hypot(dir.x, dir.y) || 1
    return Math.abs((dx * dir.x + dy * dir.y) / (len * dlen))
  }
  const own = align(medians[owner])
  return partners.some((partner) => align(medians[partner]) > own)
}

function closestDirection(point: Pt, median: Pt[]): Pt {
  let best = Infinity
  let dir = { x: 1, y: 0 }
  for (let i = 0; i < median.length - 1; i++) {
    const dist = pointSegmentDistance(point, median[i], median[i + 1])
    if (dist >= best) continue
    best = dist
    dir = { x: median[i + 1].x - median[i].x, y: median[i + 1].y - median[i].y }
  }
  return dir
}

function nearPartner(point: Pt, medians: Pt[][], partners: number[], wall: number): boolean {
  return partners.some((partner) => distanceToMedian(point, medians[partner]) < wall)
}

function sharpTurn(ring: Pt[], index: number): boolean {
  const n = ring.length
  const a = ring[(index - 1 + n) % n]
  const b = ring[index]
  const c = ring[(index + 1) % n]
  const ux = b.x - a.x
  const uy = b.y - a.y
  const vx = c.x - b.x
  const vy = c.y - b.y
  const lu = Math.hypot(ux, uy)
  const lv = Math.hypot(vx, vy)
  if (lu < 0.5 || lv < 0.5) return false
  return (ux * vx + uy * vy) / (lu * lv) <= SHARP_TURN
}

function chordCubic(a: Pt, b: Pt): string {
  const c1 = { x: a.x + (b.x - a.x) / 3, y: a.y + (b.y - a.y) / 3 }
  const c2 = { x: a.x + ((b.x - a.x) * 2) / 3, y: a.y + ((b.y - a.y) * 2) / 3 }
  return `C ${fmt(c1)} ${fmt(c2)} ${fmt(b)}`
}

function crossingPartners(medians: Pt[][]): number[][] {
  const partners = medians.map(() => [] as number[])
  for (let i = 0; i < medians.length; i++) {
    for (let j = i + 1; j < medians.length; j++) {
      if (!closestCrossing(medians[i], medians[j])) continue
      partners[i].push(j)
      partners[j].push(i)
    }
  }
  return partners
}

function distanceToMedian(point: Pt, median: Pt[]): number {
  let best = Infinity
  for (let i = 0; i < median.length - 1; i++) best = Math.min(best, pointSegmentDistance(point, median[i], median[i + 1]))
  return best
}

function closestCrossing(a: Pt[], b: Pt[]): Pt | null {
  let best = Infinity
  let mid: Pt | null = null
  for (let i = 0; i < a.length - 1; i++) {
    for (let step = 0; step <= 8; step++) {
      const t = step / 8
      const point = { x: a[i].x + (a[i + 1].x - a[i].x) * t, y: a[i].y + (a[i + 1].y - a[i].y) * t }
      for (let j = 0; j < b.length - 1; j++) {
        const dist = pointSegmentDistance(point, b[j], b[j + 1])
        if (dist >= best || dist > CROSSING_APPROACH) continue
        best = dist
        const dx = b[j + 1].x - b[j].x
        const dy = b[j + 1].y - b[j].y
        const len2 = dx * dx + dy * dy || 1
        const u = Math.max(0, Math.min(1, ((point.x - b[j].x) * dx + (point.y - b[j].y) * dy) / len2))
        mid = { x: (point.x + b[j].x + dx * u) / 2, y: (point.y + b[j].y + dy * u) / 2 }
      }
    }
  }
  return mid
}

function nearest(point: Pt, medians: Pt[][]): number {
  let best = 0
  let bestDist = Infinity
  for (let s = 0; s < medians.length; s++) {
    const median = medians[s]
    for (let j = 0; j < median.length - 1; j++) {
      const dist = pointSegmentDistance(point, median[j], median[j + 1])
      if (dist < bestDist) {
        bestDist = dist
        best = s
      }
    }
  }
  return best
}

function smooth(labels: number[]): number[] {
  const n = labels.length
  const out = labels.slice()
  for (let i = 0; i < n; i++) {
    const prev = labels[(i - 1 + n) % n]
    const next = labels[(i + 1) % n]
    if (prev === next && out[i] !== prev) out[i] = prev
  }
  return out
}

function runsOf(labels: number[], stroke: number): Run[] {
  const n = labels.length
  const owned = labels.map((label) => label === stroke)
  if (owned.every(Boolean)) return [{ from: 0, to: n - 1, full: true }]
  const start = owned.findIndex((flag) => !flag)
  if (start < 0) return []
  const runs: Run[] = []
  let i = 0
  while (i < n) {
    const idx = (start + i) % n
    if (!owned[idx]) {
      i++
      continue
    }
    let j = i
    while (j < n && owned[(start + j) % n]) j++
    runs.push({ from: idx, to: (start + j - 1) % n })
    i = j
  }
  return runs
}

function resample(pts: Pt[]): Pt[] {
  const ring = openRing(pts)
  if (ring.length < 3) return ring
  const out: Pt[] = []
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    out.push(a)
    const dist = Math.hypot(b.x - a.x, b.y - a.y)
    const steps = Math.floor(dist / SAMPLE_STEP)
    for (let k = 1; k < steps; k++) {
      const t = k / steps
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })
    }
  }
  return out
}

function openRing(pts: Pt[]): Pt[] {
  if (pts.length < 2) return pts.slice()
  const first = pts[0]
  const last = pts[pts.length - 1]
  if (first.x === last.x && first.y === last.y) return pts.slice(0, -1)
  return pts.slice()
}

function closedPolyline(ring: Pt[]): string {
  return `M ${fmt(ring[0])} ${ring.slice(1).map((p) => `L ${fmt(p)}`).join(' ')} Z`
}

type Loc = { seg: number; t: number; point: Pt }

function locate(ring: Pt[], point: Pt): Loc {
  let best: Loc = { seg: 0, t: 0, point: ring[0] }
  let bestDist = Infinity
  const n = ring.length
  for (let i = 0; i < n; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % n]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2))
    const at = { x: a.x + dx * t, y: a.y + dy * t }
    const dist = Math.hypot(point.x - at.x, point.y - at.y)
    if (dist < bestDist) {
      bestDist = dist
      best = { seg: i, t, point: at }
    }
  }
  return best
}

function walk(ring: Pt[], from: Loc, to: Loc): Pt[] {
  const n = ring.length
  const pts = [from.point]
  if (from.seg === to.seg && to.t >= from.t) {
    pts.push(to.point)
    return pts
  }
  let seg = from.seg
  for (let step = 0; step < n; step++) {
    const next = (seg + 1) % n
    pts.push(ring[next])
    seg = next
    if (seg === to.seg) {
      pts.push(to.point)
      return pts
    }
  }
  pts.push(to.point)
  return pts
}

function lengthOf(pts: Pt[]): number {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return total
}

function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const point of pts) {
    const prev = out[out.length - 1]
    if (!prev || Math.hypot(prev.x - point.x, prev.y - point.y) >= 0.5) out.push(point)
  }
  return out
}

function appendSpline(cmds: string[], points: Pt[]) {
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
    cmds.push(`C ${fmt(c1)} ${fmt(c2)} ${fmt(p2)}`)
  }
}

function fmt(point: Pt): string {
  return `${round1(point.x)} ${round1(point.y)}`
}
