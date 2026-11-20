import { pointSegmentDistance, type Pt } from '../paths.ts'
import type { Raster } from './raster.ts'

// 다른 획과 만나는 획의 시작·끝 단면이 상대 획 폭 대비 겹칠 비율 범위
export type EndOverlapRange = { min: number; max: number }

const ENTRY_TOLERANCE = 8
const MAX_RAY_DIST = 320
const PARTNER_WIDTH_CAP = 1.35
const END_ARCH_INSET = 0.12
const END_PARAM_THRESHOLD = 0.3
const END_NORMAL_MIN_COS = 0.35
const RASTER_CONTACT_MIN_DOT = 0.15
const CHORD_INK_RADIUS = 8
const CHORD_CHECK_TS = [0.35, 0.5, 0.65] as const
const SAMPLE_TS = [0.08, 0.15, 0.25, 0.4, 0.5, 0.6, 0.75, 0.85, 0.92] as const
const CARDINAL_DIRS = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
] as const

function isInkAt(raster: Raster, x: number, y: number): boolean {
  const gx = Math.round(raster.pad + (x - raster.minX) * raster.scale)
  const gy = Math.round(raster.pad + (raster.maxY - y) * raster.scale)
  return gx >= 0 && gy >= 0 && gx < raster.w && gy < raster.h && raster.ink[gy * raster.w + gx] === 1
}

function isNearInk(raster: Raster, x: number, y: number, radiusFont: number): boolean {
  const gx = Math.round(raster.pad + (x - raster.minX) * raster.scale)
  const gy = Math.round(raster.pad + (raster.maxY - y) * raster.scale)
  const rPx = Math.max(1, Math.ceil(radiusFont * raster.scale))
  const step = Math.max(1, Math.floor(rPx / 2))
  for (let dy = -rPx; dy <= rPx; dy += step) {
    const py = gy + dy
    if (py < 0 || py >= raster.h) continue
    for (let dx = -rPx; dx <= rPx; dx += step) {
      if (dx * dx + dy * dy > rPx * rPx) continue
      const px = gx + dx
      if (px >= 0 && px < raster.w && raster.ink[py * raster.w + px] === 1) return true
    }
  }
  return false
}

/** 브릿지 현의 중간 표본들이 모두 잉크(또는 인접 경계) 위를 지나는지 확인해 빈 구멍 횡단을 걸러낸다. */
export function chordNearInk(raster: Raster, a: Pt, b: Pt): boolean {
  return CHORD_CHECK_TS.every((t) =>
    isNearInk(raster, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, CHORD_INK_RADIUS),
  )
}

function pixelToFontPoint(raster: Raster, index: number): Pt {
  const gx = index % raster.w
  const gy = (index / raster.w) | 0
  return {
    x: raster.minX + (gx - raster.pad) / raster.scale,
    y: raster.maxY - (gy - raster.pad) / raster.scale,
  }
}

function rayInkSpan(
  raster: Raster,
  origin: Pt,
  dir: Pt,
  maxDist = MAX_RAY_DIST,
): { enter: number; exit: number; span: number } {
  const step = 0.5 / raster.scale
  let enter = -1
  for (let t = 0; t <= ENTRY_TOLERANCE; t += step) {
    if (isInkAt(raster, origin.x + dir.x * t, origin.y + dir.y * t)) {
      enter = t
      break
    }
  }
  if (enter < 0) return { enter: 0, exit: 0, span: 0 }
  let lastIn = enter
  const gapTol = 2 / raster.scale
  for (let t = enter; t <= maxDist; t += step) {
    if (isInkAt(raster, origin.x + dir.x * t, origin.y + dir.y * t)) lastIn = t
    else if (t - lastIn > gapTol) break
  }
  return { enter, exit: lastIn, span: lastIn - enter }
}

/** 각 중심선을 따라 래스터 잉크의 국소 수직 폭 중앙값을 잰다. */
export function measureMedianWidths(raster: Raster, medians: Pt[][]): number[] {
  return medians.map((med) => {
    const widths: number[] = []
    for (let i = 0; i < med.length - 1; i++) {
      const a = med[i]
      const b = med[i + 1]
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      if (len < 1) continue
      const nx = -(b.y - a.y) / len
      const ny = (b.x - a.x) / len
      const count = Math.max(2, Math.min(8, Math.ceil(len / 30)))
      for (let k = 1; k <= count; k++) {
        const u = k / (count + 1)
        const q = { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
        if (!isInkAt(raster, q.x, q.y)) continue
        const d1 = rayInkSpan(raster, q, { x: nx, y: ny }).exit
        const d2 = rayInkSpan(raster, q, { x: -nx, y: -ny }).exit
        if (d1 + d2 > 4) widths.push(d1 + d2)
      }
    }
    if (widths.length === 0) return 0
    widths.sort((x, y) => x - y)
    return widths[Math.floor(widths.length / 2)]
  })
}

/** owner를 제외하고 point에 가장 가까운 중심선 인덱스를 돌려준다. 없으면 -1. */
export function nearestPartnerIndex(point: Pt, medians: Pt[][], owner: number): number {
  let best = -1
  let bestDist = Infinity
  for (let s = 0; s < medians.length; s++) {
    if (s === owner) continue
    const med = medians[s]
    for (let j = 0; j < med.length - 1; j++) {
      const dist = pointSegmentDistance(point, med[j], med[j + 1])
      if (dist < bestDist) {
        bestDist = dist
        best = s
      }
    }
  }
  return best
}

function medianProjection(
  median: Pt[],
  point: Pt,
): { param: number; tangent: Pt; distance: number; closest: Pt } {
  if (median.length === 0) {
    return { param: 0, tangent: { x: 1, y: 0 }, distance: Infinity, closest: { x: 0, y: 0 } }
  }
  if (median.length === 1) {
    return {
      param: 0,
      tangent: { x: 1, y: 0 },
      distance: Math.hypot(point.x - median[0].x, point.y - median[0].y),
      closest: median[0],
    }
  }
  let total = 0
  const lengths: number[] = []
  for (let i = 0; i < median.length - 1; i++) {
    const len = Math.hypot(median[i + 1].x - median[i].x, median[i + 1].y - median[i].y)
    lengths.push(len)
    total += len
  }
  if (total === 0) {
    return {
      param: 0,
      tangent: { x: 1, y: 0 },
      distance: Math.hypot(point.x - median[0].x, point.y - median[0].y),
      closest: median[0],
    }
  }
  let bestDist = Infinity
  let bestParam = 0
  let bestClosest = median[0]
  let bestTangent = { x: 1, y: 0 }
  let acc = 0
  for (let i = 0; i < median.length - 1; i++) {
    const a = median[i]
    const b = median[i + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = lengths[i]
    const len2 = dx * dx + dy * dy
    const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / len2))
    const cx = a.x + dx * u
    const cy = a.y + dy * u
    const dist = Math.hypot(point.x - cx, point.y - cy)
    if (dist < bestDist || (Math.abs(dist - bestDist) < 1e-6 && len > 0)) {
      bestDist = dist
      bestParam = (acc + u * len) / total
      bestClosest = { x: cx, y: cy }
      if (len > 0) bestTangent = { x: dx / len, y: dy / len }
    }
    acc += len
  }
  return { param: bestParam, tangent: bestTangent, distance: bestDist, closest: bestClosest }
}

/** 끊긴 브릿지 구간이 연속 획의 옆면이 아니라 시작·끝 단면인지 판정한다. */
export function isStrokeEndGap(mid: Pt, chordLen: number, nOut: Pt, median: Pt[], ownerWidth: number): boolean {
  if (median.length < 2) return false
  const proj = medianProjection(median, mid)
  const reach = Math.max(chordLen * 1.5, ownerWidth * 1.8, 140)
  const startDist = Math.hypot(mid.x - median[0].x, mid.y - median[0].y)
  const tail = median[median.length - 1]
  const endDist = Math.hypot(mid.x - tail.x, mid.y - tail.y)
  const align = nOut.x * proj.tangent.x + nOut.y * proj.tangent.y
  const isStart = proj.param <= END_PARAM_THRESHOLD && startDist <= reach && -align >= END_NORMAL_MIN_COS
  const isEnd = proj.param >= 1 - END_PARAM_THRESHOLD && endDist <= reach && align >= END_NORMAL_MIN_COS
  return isStart || isEnd
}

/** 단면 중심에서 상대 획 방향으로 겹쳐 들어갈 목표 깊이와 최대 허용 깊이를 구한다. */
export function targetOverlapDepth(
  raster: Raster,
  origin: Pt,
  dir: Pt,
  partnerWidth: number,
  range: EndOverlapRange,
): { target: number; max: number; ray: { enter: number; exit: number; span: number } } {
  const ray = rayInkSpan(raster, origin, dir)
  if (ray.span <= 0) return { target: 0, max: 0, ray }
  const eff = partnerWidth > 0 && ray.span > partnerWidth * PARTNER_WIDTH_CAP ? partnerWidth : ray.span
  const targetRatio = (range.min + range.max) / 2
  const max = Math.min(ray.enter + eff * range.max, ray.enter + ray.span * range.max)
  const target = Math.min(ray.enter + eff * targetRatio, max)
  return { target, max, ray }
}

function controlsForDepth(a: Pt, b: Pt, nOut: Pt, depth: number): { c1: Pt; c2: Pt } {
  const k = (4 / 3) * depth
  return {
    c1: { x: a.x + (b.x - a.x) * END_ARCH_INSET + nOut.x * k, y: a.y + (b.y - a.y) * END_ARCH_INSET + nOut.y * k },
    c2: { x: b.x - (b.x - a.x) * END_ARCH_INSET + nOut.x * k, y: b.y - (b.y - a.y) * END_ARCH_INSET + nOut.y * k },
  }
}

function cubicPoint(a: Pt, c1: Pt, c2: Pt, b: Pt, t: number): Pt {
  const mt = 1 - t
  return {
    x: mt * mt * mt * a.x + 3 * mt * mt * t * c1.x + 3 * mt * t * t * c2.x + t * t * t * b.x,
    y: mt * mt * mt * a.y + 3 * mt * mt * t * c1.y + 3 * mt * t * t * c2.y + t * t * t * b.y,
  }
}

/** 원본 잉크 바깥으로 나가지 않는 한도 내에서 depth만큼 겹치는 3차 베지어 제어점을 만든다. */
export function buildOverlapCubic(
  a: Pt,
  b: Pt,
  nOut: Pt,
  depth: number,
  raster: Raster,
): { c1: Pt; c2: Pt } | null {
  if (depth < 1) return null
  const fits = (h: number) => {
    const { c1, c2 } = controlsForDepth(a, b, nOut, h)
    return SAMPLE_TS.every((t) => {
      const pt = cubicPoint(a, c1, c2, b, t)
      return isInkAt(raster, pt.x, pt.y)
    })
  }
  if (fits(depth)) return controlsForDepth(a, b, nOut, depth)
  let lo = 0
  let hi = depth
  for (let iter = 0; iter < 8; iter++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return lo < 1 ? null : controlsForDepth(a, b, nOut, lo)
}

type EndFrame = { which: 'start' | 'end'; tip: Pt; u: Pt; n: Pt }
type EndContact = { mid: Pt; partner: number; centerSide: number; faceHalfW: number }

function outwardEndFrame(median: Pt[], which: 'start' | 'end'): EndFrame | null {
  const chain = which === 'start' ? median : median.slice().reverse()
  const tip = chain[0]
  let inner = chain[1]
  for (let i = 1; i < chain.length; i++) {
    inner = chain[i]
    if (Math.hypot(inner.x - tip.x, inner.y - tip.y) >= 30) break
  }
  const dx = tip.x - inner.x
  const dy = tip.y - inner.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return null
  const u = { x: dx / len, y: dy / len }
  return { which, tip, u, n: { x: -u.y, y: u.x } }
}

function collectEndContacts(
  ownerMap: Int16Array,
  raster: Raster,
  median: Pt[],
  strokeIndex: number,
  frame: EndFrame,
  ownerWidth: number,
): EndContact | null {
  const { w, h } = raster
  const reach = Math.max(ownerWidth * 1.6, 160)
  const pts: Pt[] = []
  const partnerCounts = new Map<number, number>()
  for (let i = 0; i < ownerMap.length; i++) {
    if (ownerMap[i] !== strokeIndex) continue
    const gx = i % w
    const gy = (i / w) | 0
    let matchedPartner = -1
    let bestDot = -Infinity
    for (const dir of CARDINAL_DIRS) {
      const nx = gx + dir.dx
      const ny = gy + dir.dy
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const nbOwner = ownerMap[ny * w + nx]
      if (nbOwner < 0 || nbOwner === strokeIndex) continue
      const dot = dir.dx * frame.u.x - dir.dy * frame.u.y
      if (dot >= RASTER_CONTACT_MIN_DOT && dot > bestDot) {
        bestDot = dot
        matchedPartner = nbOwner
      }
    }
    if (matchedPartner < 0) continue
    const pt = pixelToFontPoint(raster, i)
    if (Math.hypot(pt.x - frame.tip.x, pt.y - frame.tip.y) > reach) continue
    const proj = medianProjection(median, pt)
    const endMatch = frame.which === 'start' ? proj.param <= END_PARAM_THRESHOLD : proj.param >= 1 - END_PARAM_THRESHOLD
    if (!endMatch) continue
    pts.push(pt)
    partnerCounts.set(matchedPartner, (partnerCounts.get(matchedPartner) ?? 0) + 1)
  }
  if (pts.length < 2) return null
  let sumX = 0
  let sumY = 0
  for (const p of pts) {
    sumX += p.x
    sumY += p.y
  }
  const mid = { x: sumX / pts.length, y: sumY / pts.length }
  let partner = -1
  let bestCount = -1
  for (const [candidate, count] of partnerCounts) {
    if (count > bestCount) {
      bestCount = count
      partner = candidate
    }
  }
  if (partner < 0) return null
  let minSide = Infinity
  let maxSide = -Infinity
  for (const p of pts) {
    const s = (p.x - mid.x) * frame.n.x + (p.y - mid.y) * frame.n.y
    if (s < minSide) minSide = s
    if (s > maxSide) maxSide = s
  }
  const centerSide = (minSide + maxSide) / 2
  const faceHalfW = Math.max(4, Math.min((ownerWidth || 80) * 0.6, (maxSide - minSide) / 2))
  return { mid, partner, centerSide, faceHalfW }
}

function rasterAlongBounds(
  ray: { enter: number; exit: number; span: number },
  partnerMedian: Pt[],
  mid: Pt,
  u: Pt,
  partnerW: number,
  range: EndOverlapRange,
  scale: number,
): { targetAlong: number; maxAlong: number } {
  const targetRatio = (range.min + range.max) / 2
  let targetAlong: number
  let maxAlong: number
  if (partnerW > 0 && ray.exit <= partnerW * 1.15) {
    targetAlong = Math.max(0, ray.exit - (1 - targetRatio) * partnerW)
    maxAlong = Math.max(0, ray.exit - (1 - range.max) * partnerW)
  } else if (partnerW > 0) {
    const pProj = medianProjection(partnerMedian, mid)
    const dToMed = (pProj.closest.x - mid.x) * u.x + (pProj.closest.y - mid.y) * u.y
    targetAlong = Math.max(0, Math.min(ray.exit * range.max, dToMed + (targetRatio - 0.5) * partnerW))
    maxAlong = Math.max(0, Math.min(ray.exit * range.max, dToMed + (range.max - 0.5) * partnerW))
  } else {
    targetAlong = ray.enter + ray.span * targetRatio
    maxAlong = ray.enter + ray.span * range.max
  }
  const safeLimit = Math.max(0, ray.exit - 1 / scale)
  return {
    targetAlong: Math.min(targetAlong, safeLimit),
    maxAlong: Math.min(maxAlong, safeLimit),
  }
}

function applyEndOverlapWindow(
  mask: Uint8Array,
  ownerMap: Int16Array,
  raster: Raster,
  frame: EndFrame,
  contact: EndContact,
  rayExit: number,
  targetAlong: number,
  maxAlong: number,
): void {
  const { mid, partner, centerSide, faceHalfW } = contact
  const maxA = rayExit + 4
  const maxS = faceHalfW + 8
  const sideOriginX = mid.x + centerSide * frame.n.x
  const sideOriginY = mid.y + centerSide * frame.n.y
  let minFx = Infinity
  let maxFx = -Infinity
  let minFy = Infinity
  let maxFy = -Infinity
  for (const a of [0, maxA]) {
    for (const s of [-maxS, maxS]) {
      const fx = sideOriginX + a * frame.u.x + s * frame.n.x
      const fy = sideOriginY + a * frame.u.y + s * frame.n.y
      if (fx < minFx) minFx = fx
      if (fx > maxFx) maxFx = fx
      if (fy < minFy) minFy = fy
      if (fy > maxFy) maxFy = fy
    }
  }
  const gx0 = Math.max(0, Math.floor(raster.pad + (minFx - raster.minX) * raster.scale))
  const gx1 = Math.min(raster.w - 1, Math.ceil(raster.pad + (maxFx - raster.minX) * raster.scale))
  const gy0 = Math.max(0, Math.floor(raster.pad + (raster.maxY - maxFy) * raster.scale))
  const gy1 = Math.min(raster.h - 1, Math.ceil(raster.pad + (raster.maxY - minFy) * raster.scale))
  for (let gy = gy0; gy <= gy1; gy++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const idx = gy * raster.w + gx
      if (!raster.ink[idx]) continue
      const pt = pixelToFontPoint(raster, idx)
      const dx = pt.x - mid.x
      const dy = pt.y - mid.y
      const along = dx * frame.u.x + dy * frame.u.y
      if (along < 0 || along > maxA) continue
      const side = dx * frame.n.x + dy * frame.n.y - centerSide
      if (Math.abs(side) > maxS) continue
      if (ownerMap[idx] === partner && along > maxAlong && Math.abs(side) <= faceHalfW + 6) {
        mask[idx] = 0
      }
      if (targetAlong > 1 && along <= targetAlong) {
        const halfSpan = faceHalfW * Math.sqrt(Math.max(0, 1 - (along / targetAlong) ** 2))
        if (Math.abs(side) <= halfSpan) mask[idx] = 1
      }
    }
  }
}

/** 래스터 폴백 분할 획의 시작·끝 접합부를 상대 획 폭의 range(예: 1/2~2/3)까지 겹치게 보정하고 초과 번짐을 잘라낸다. */
export function applyRasterEndOverlap(
  mask: Uint8Array,
  ownerMap: Int16Array,
  raster: Raster,
  medians: Pt[][],
  strokeIndex: number,
  strokeWidths: number[],
  range: EndOverlapRange,
): void {
  const med = medians[strokeIndex]
  if (!med || med.length < 2) return
  for (const which of ['start', 'end'] as const) {
    const frame = outwardEndFrame(med, which)
    if (!frame) continue
    const contact = collectEndContacts(ownerMap, raster, med, strokeIndex, frame, strokeWidths[strokeIndex] || 0)
    if (!contact) continue
    const ray = rayInkSpan(raster, contact.mid, frame.u)
    if (ray.exit <= 1) continue
    const partnerMed = medians[contact.partner] ?? []
    const partnerW = strokeWidths[contact.partner] || 0
    if (partnerMed.length >= 2) {
      const pProj = medianProjection(partnerMed, contact.mid)
      const colinear = Math.abs(frame.u.x * pProj.tangent.x + frame.u.y * pProj.tangent.y) >= 0.85
      if (colinear && ray.exit > (partnerW || 80) * 1.15) continue
    }
    const { targetAlong, maxAlong } = rasterAlongBounds(
      ray,
      partnerMed,
      contact.mid,
      frame.u,
      partnerW,
      range,
      raster.scale,
    )
    applyEndOverlapWindow(mask, ownerMap, raster, frame, contact, ray.exit, targetAlong, maxAlong)
  }
}
