import { round1 } from '../../shared/paths.ts'
import { simplifyPolyline } from '../../shared/strokeCut.ts'
import type { Pt } from '../../shared/types.ts'
import type { BBox, EditableSeg } from './vectorEdit.ts'

const SEAM_EPSILON = 0.5
const SPLIT_T_MIN = 0.05
const SPLIT_T_MAX = 0.95
const CURVE_COARSE_STEPS = 24
const CURVE_REFINE_STEPS = 8
const ARC_LENGTH_STEPS = 8

type Subpath = {
  start: number
  end: number
  closed: boolean
  seamPartner: number | null
}

function anchorPointOf(seg: EditableSeg | undefined): Pt | null {
  if (!seg || seg.op === 'Z') return null
  return [seg.x, seg.y]
}

function parseSubpaths(segs: EditableSeg[]): Subpath[] {
  const subpaths: Subpath[] = []
  let i = 0
  while (i < segs.length) {
    if (segs[i].op !== 'M') {
      i++
      continue
    }
    const start = i
    i++
    while (i < segs.length && segs[i].op !== 'M' && segs[i].op !== 'Z') {
      i++
    }
    const closed = i < segs.length && segs[i].op === 'Z'
    const end = i
    let seamPartner: number | null = null
    if (closed && end - 1 > start) {
      const m = anchorPointOf(segs[start])
      const last = anchorPointOf(segs[end - 1])
      if (m && last && Math.hypot(last[0] - m[0], last[1] - m[1]) < SEAM_EPSILON) {
        seamPartner = end - 1
      }
    }
    subpaths.push({ start, end, closed, seamPartner })
    if (closed) i++
  }
  return subpaths
}

function startPointOfSegment(segs: EditableSeg[], index: number): Pt | null {
  if (index <= 0 || index >= segs.length) return null
  const prev = segs[index - 1]
  if (prev.op !== 'Z') return anchorPointOf(prev)
  for (let i = index - 2; i >= 0; i--) {
    if (segs[i].op === 'M') return anchorPointOf(segs[i])
  }
  return null
}

export function expandSeamPartners(segs: EditableSeg[], indices: Iterable<number>): Set<number> {
  const selected = new Set<number>()
  for (const idx of indices) {
    if (Number.isInteger(idx) && idx >= 0 && idx < segs.length && segs[idx].op !== 'Z') {
      selected.add(idx)
    }
  }
  if (selected.size === 0) return selected
  for (const sub of parseSubpaths(segs)) {
    if (sub.seamPartner === null) continue
    if (selected.has(sub.start)) selected.add(sub.seamPartner)
    else if (selected.has(sub.seamPartner)) selected.add(sub.start)
  }
  return selected
}

export function anchorIndicesInBox(segs: EditableSeg[], box: BBox): number[] {
  const hits: number[] = []
  segs.forEach((seg, idx) => {
    const pt = anchorPointOf(seg)
    if (!pt) return
    if (pt[0] >= box.minX && pt[0] <= box.maxX && pt[1] >= box.minY && pt[1] <= box.maxY) {
      hits.push(idx)
    }
  })
  return [...expandSeamPartners(segs, hits)].sort((a, b) => a - b)
}

export function moveEditableAnchors(segs: EditableSeg[], segIndices: Iterable<number>, dx: number, dy: number): EditableSeg[] {
  const next = segs.map((s) => ({ ...s }))
  const selected = expandSeamPartners(next, segIndices)
  if (selected.size === 0 || (dx === 0 && dy === 0)) return next

  for (const idx of selected) {
    const seg = next[idx]
    if (!seg || seg.op === 'Z') continue
    seg.x = round1(seg.x + dx)
    seg.y = round1(seg.y + dy)
    if (seg.op === 'C') {
      seg.x2 = round1(seg.x2 + dx)
      seg.y2 = round1(seg.y2 + dy)
    }
    const after = next[idx + 1]
    if (after && (after.op === 'Q' || after.op === 'C')) {
      after.x1 = round1(after.x1 + dx)
      after.y1 = round1(after.y1 + dy)
    }
  }
  return next
}

const lerpPt = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]

function evalSegAt(p0: Pt, seg: EditableSeg, t: number): Pt {
  if (seg.op === 'Q') {
    const c: Pt = [seg.x1, seg.y1]
    const p2: Pt = [seg.x, seg.y]
    return lerpPt(lerpPt(p0, c, t), lerpPt(c, p2, t), t)
  }
  if (seg.op === 'C') {
    const p1: Pt = [seg.x1, seg.y1]
    const p2: Pt = [seg.x2, seg.y2]
    const p3: Pt = [seg.x, seg.y]
    const a = lerpPt(p0, p1, t)
    const b = lerpPt(p1, p2, t)
    const c = lerpPt(p2, p3, t)
    return lerpPt(lerpPt(a, b, t), lerpPt(b, c, t), t)
  }
  return lerpPt(p0, anchorPointOf(seg) ?? p0, t)
}

function closestTOnSegment(p0: Pt, seg: EditableSeg, at: Pt): { t: number; dist: number } {
  if (seg.op === 'L') {
    const dx = seg.x - p0[0]
    const dy = seg.y - p0[1]
    const len2 = dx * dx + dy * dy
    const raw = len2 === 0 ? 0.5 : ((at[0] - p0[0]) * dx + (at[1] - p0[1]) * dy) / len2
    const t = Math.max(SPLIT_T_MIN, Math.min(SPLIT_T_MAX, raw))
    const pt = lerpPt(p0, [seg.x, seg.y], t)
    return { t, dist: Math.hypot(at[0] - pt[0], at[1] - pt[1]) }
  }

  let bestT = 0.5
  let bestDist = Infinity
  const step = (SPLIT_T_MAX - SPLIT_T_MIN) / CURVE_COARSE_STEPS
  for (let i = 0; i <= CURVE_COARSE_STEPS; i++) {
    const t = SPLIT_T_MIN + step * i
    const pt = evalSegAt(p0, seg, t)
    const d = Math.hypot(at[0] - pt[0], at[1] - pt[1])
    if (d < bestDist) {
      bestDist = d
      bestT = t
    }
  }
  const lo = Math.max(SPLIT_T_MIN, bestT - step / 2)
  const hi = Math.min(SPLIT_T_MAX, bestT + step / 2)
  for (let i = 0; i <= CURVE_REFINE_STEPS; i++) {
    const t = lo + ((hi - lo) * i) / CURVE_REFINE_STEPS
    const pt = evalSegAt(p0, seg, t)
    const d = Math.hypot(at[0] - pt[0], at[1] - pt[1])
    if (d < bestDist) {
      bestDist = d
      bestT = t
    }
  }
  return { t: bestT, dist: bestDist }
}

function splitSegmentAt(p0: Pt, seg: EditableSeg, t: number): [EditableSeg, EditableSeg] | null {
  if (seg.op === 'L') {
    const m = lerpPt(p0, [seg.x, seg.y], t)
    return [
      { op: 'L', x: round1(m[0]), y: round1(m[1]) },
      { op: 'L', x: round1(seg.x), y: round1(seg.y) },
    ]
  }
  if (seg.op === 'Q') {
    const p1: Pt = [seg.x1, seg.y1]
    const p2: Pt = [seg.x, seg.y]
    const q0 = lerpPt(p0, p1, t)
    const q1 = lerpPt(p1, p2, t)
    const m = lerpPt(q0, q1, t)
    return [
      { op: 'Q', x1: round1(q0[0]), y1: round1(q0[1]), x: round1(m[0]), y: round1(m[1]) },
      { op: 'Q', x1: round1(q1[0]), y1: round1(q1[1]), x: round1(seg.x), y: round1(seg.y) },
    ]
  }
  if (seg.op === 'C') {
    const p1: Pt = [seg.x1, seg.y1]
    const p2: Pt = [seg.x2, seg.y2]
    const p3: Pt = [seg.x, seg.y]
    const a = lerpPt(p0, p1, t)
    const b = lerpPt(p1, p2, t)
    const c = lerpPt(p2, p3, t)
    const d = lerpPt(a, b, t)
    const e = lerpPt(b, c, t)
    const m = lerpPt(d, e, t)
    return [
      { op: 'C', x1: round1(a[0]), y1: round1(a[1]), x2: round1(d[0]), y2: round1(d[1]), x: round1(m[0]), y: round1(m[1]) },
      { op: 'C', x1: round1(e[0]), y1: round1(e[1]), x2: round1(c[0]), y2: round1(c[1]), x: round1(seg.x), y: round1(seg.y) },
    ]
  }
  return null
}

function segmentLength(p0: Pt, seg: EditableSeg): number {
  if (seg.op === 'L') return Math.hypot(seg.x - p0[0], seg.y - p0[1])
  if (seg.op !== 'Q' && seg.op !== 'C') return 0
  let total = 0
  let prev = p0
  for (let i = 1; i <= ARC_LENGTH_STEPS; i++) {
    const cur = evalSegAt(p0, seg, i / ARC_LENGTH_STEPS)
    total += Math.hypot(cur[0] - prev[0], cur[1] - prev[1])
    prev = cur
  }
  return total
}

export function insertPathPointAt(segs: EditableSeg[], at: Pt): { segs: EditableSeg[]; insertedIndex: number } | null {
  type Candidate =
    | { kind: 'seg'; index: number; p0: Pt; t: number; dist: number }
    | { kind: 'close'; insertAt: number; from: Pt; to: Pt; t: number; dist: number }

  let best: Candidate | null = null

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i]
    if (seg.op !== 'L' && seg.op !== 'Q' && seg.op !== 'C') continue
    const p0 = startPointOfSegment(segs, i)
    if (!p0) continue
    const { t, dist } = closestTOnSegment(p0, seg, at)
    if (!best || dist < best.dist) {
      best = { kind: 'seg', index: i, p0, t, dist }
    }
  }

  for (const sub of parseSubpaths(segs)) {
    if (!sub.closed || sub.seamPartner !== null || sub.end - 1 < sub.start) continue
    const from = anchorPointOf(segs[sub.end - 1])
    const to = anchorPointOf(segs[sub.start])
    if (!from || !to || Math.hypot(from[0] - to[0], from[1] - to[1]) < SEAM_EPSILON) continue
    const closingSeg: EditableSeg = { op: 'L', x: to[0], y: to[1] }
    const { t, dist } = closestTOnSegment(from, closingSeg, at)
    if (!best || dist < best.dist) {
      best = { kind: 'close', insertAt: sub.end, from, to, t, dist }
    }
  }

  if (!best) return null
  const next = segs.map((s) => ({ ...s }))
  if (best.kind === 'seg') {
    const pair = splitSegmentAt(best.p0, next[best.index], best.t)
    if (!pair) return null
    next.splice(best.index, 1, pair[0], pair[1])
    return { segs: next, insertedIndex: best.index }
  }
  const mid = lerpPt(best.from, best.to, best.t)
  next.splice(best.insertAt, 0, { op: 'L', x: round1(mid[0]), y: round1(mid[1]) })
  return { segs: next, insertedIndex: best.insertAt }
}

export function insertPathPointOnSelection(
  segs: EditableSeg[],
  selectedIndices: Iterable<number>,
): { segs: EditableSeg[]; insertedIndices: number[] } | null {
  type Target =
    | { kind: 'seg'; index: number }
    | { kind: 'close'; index: number; from: Pt; to: Pt }

  const expanded = expandSeamPartners(segs, selectedIndices)
  const segTargets = new Set<number>()
  for (const idx of expanded) {
    const seg = segs[idx]
    if (!seg) continue
    if (seg.op === 'L' || seg.op === 'Q' || seg.op === 'C') {
      segTargets.add(idx)
    } else if (seg.op === 'M') {
      const after = segs[idx + 1]
      if (after && (after.op === 'L' || after.op === 'Q' || after.op === 'C')) {
        segTargets.add(idx + 1)
      }
    }
  }

  const targets: Target[] = [...segTargets].sort((a, b) => a - b).map((index) => ({ kind: 'seg', index }))

  if (targets.length === 0) {
    let bestTarget: Target | null = null
    let bestLen = -1
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i]
      if (seg.op !== 'L' && seg.op !== 'Q' && seg.op !== 'C') continue
      const p0 = startPointOfSegment(segs, i)
      if (!p0) continue
      const len = segmentLength(p0, seg)
      if (len > bestLen) {
        bestLen = len
        bestTarget = { kind: 'seg', index: i }
      }
    }
    for (const sub of parseSubpaths(segs)) {
      if (!sub.closed || sub.seamPartner !== null || sub.end - 1 < sub.start) continue
      const from = anchorPointOf(segs[sub.end - 1])
      const to = anchorPointOf(segs[sub.start])
      if (!from || !to) continue
      const len = Math.hypot(to[0] - from[0], to[1] - from[1])
      if (len >= SEAM_EPSILON && len > bestLen) {
        bestLen = len
        bestTarget = { kind: 'close', index: sub.end, from, to }
      }
    }
    if (!bestTarget) return null
    targets.push(bestTarget)
  }

  const next = segs.map((s) => ({ ...s }))
  const insertedIndices: number[] = []
  let shift = 0

  for (const target of targets) {
    const pos = target.index + shift
    if (target.kind === 'seg') {
      const p0 = startPointOfSegment(next, pos)
      const seg = next[pos]
      const pair = p0 && seg ? splitSegmentAt(p0, seg, 0.5) : null
      if (!pair) continue
      next.splice(pos, 1, pair[0], pair[1])
      insertedIndices.push(pos)
      shift += 1
    } else {
      const mid = lerpPt(target.from, target.to, 0.5)
      next.splice(pos, 0, { op: 'L', x: round1(mid[0]), y: round1(mid[1]) })
      insertedIndices.push(pos)
      shift += 1
    }
  }

  return insertedIndices.length > 0 ? { segs: next, insertedIndices } : null
}

export function togglePathSegmentCurve(segs: EditableSeg[], selectedIndices: Iterable<number>): EditableSeg[] | null {
  const expanded = expandSeamPartners(segs, selectedIndices)
  const targetSet = new Set<number>()
  for (const idx of expanded) {
    const seg = segs[idx]
    if (!seg) continue
    if (seg.op === 'L' || seg.op === 'Q' || seg.op === 'C') {
      targetSet.add(idx)
    } else if (seg.op === 'M') {
      const after = segs[idx + 1]
      if (after && (after.op === 'L' || after.op === 'Q' || after.op === 'C')) {
        targetSet.add(idx + 1)
      }
    }
  }
  if (targetSet.size === 0) return null

  const targets = [...targetSet].sort((a, b) => a - b)
  const hasLine = targets.some((idx) => segs[idx]?.op === 'L')
  const next = segs.map((s) => ({ ...s }))

  for (const idx of targets) {
    const seg = next[idx]
    if (!seg || seg.op === 'M' || seg.op === 'Z') continue
    if (hasLine) {
      if (seg.op !== 'L') continue
      const p0 = startPointOfSegment(next, idx)
      if (!p0) continue
      const p1: Pt = [seg.x, seg.y]
      const c1 = lerpPt(p0, p1, 1 / 3)
      const c2 = lerpPt(p0, p1, 2 / 3)
      next[idx] = {
        op: 'C',
        x1: round1(c1[0]),
        y1: round1(c1[1]),
        x2: round1(c2[0]),
        y2: round1(c2[1]),
        x: round1(p1[0]),
        y: round1(p1[1]),
      }
    } else {
      next[idx] = { op: 'L', x: round1(seg.x), y: round1(seg.y) }
    }
  }
  return next
}

function validateAnchorDeletion(segs: EditableSeg[], toRemove: Set<number>): Subpath[] | null {
  if (toRemove.size === 0) return null
  const subpaths = parseSubpaths(segs)
  for (const sub of subpaths) {
    let touchesSubpath = false
    let survivingDistinct = 0
    for (let i = sub.start; i < sub.end; i++) {
      if (toRemove.has(i)) touchesSubpath = true
      else if (i !== sub.seamPartner) survivingDistinct += 1
    }
    if (touchesSubpath && survivingDistinct < (sub.closed ? 3 : 2)) {
      return null
    }
  }
  return subpaths
}

export function canDeleteAnchors(segs: EditableSeg[], segIndices: Iterable<number>): boolean {
  return validateAnchorDeletion(segs, expandSeamPartners(segs, segIndices)) !== null
}

export function deleteEditableAnchors(segs: EditableSeg[], segIndices: Iterable<number>): EditableSeg[] | null {
  const toRemove = expandSeamPartners(segs, segIndices)
  const subpaths = validateAnchorDeletion(segs, toRemove)
  if (!subpaths) return null

  const rebuilt: EditableSeg[] = []
  for (const sub of subpaths) {
    const kept: EditableSeg[] = []
    for (let i = sub.start; i < sub.end; i++) {
      if (!toRemove.has(i)) kept.push({ ...segs[i] })
    }
    if (kept.length > 0 && kept[0].op !== 'M') {
      const first = kept[0]
      if (first.op !== 'Z') {
        kept[0] = { op: 'M', x: first.x, y: first.y }
      }
    }
    rebuilt.push(...kept)
    if (sub.closed) rebuilt.push({ op: 'Z' })
  }
  return rebuilt
}

export function simplifyEditablePath(
  segs: EditableSeg[],
  selectedIndices: Iterable<number> = [],
  tolerance = 2.5,
): EditableSeg[] | null {
  const selected = expandSeamPartners(segs, selectedIndices)
  const regionOnly = selected.size >= 3
  const subpaths = parseSubpaths(segs)
  const rebuilt: EditableSeg[] = []
  let removedAny = false

  for (const sub of subpaths) {
    const minDistinct = sub.closed ? 3 : 2
    const dropped = new Set<number>()
    let i = sub.start

    while (i < sub.end) {
      if (regionOnly && !selected.has(i)) {
        i++
        continue
      }
      const startPt = anchorPointOf(segs[i])
      if (!startPt) {
        i++
        continue
      }
      let j = i
      while (j + 1 < sub.end && segs[j + 1].op === 'L' && (!regionOnly || selected.has(j + 1))) {
        j++
      }
      if (j - i >= 2) {
        const pts: { x: number; y: number }[] = []
        const refToIdx = new Map<{ x: number; y: number }, number>()
        for (let k = i; k <= j; k++) {
          const p = anchorPointOf(segs[k])!
          const obj = { x: p[0], y: p[1] }
          pts.push(obj)
          refToIdx.set(obj, k)
        }
        const simplified = simplifyPolyline(pts, tolerance)
        if (simplified.length >= 2 && simplified.length < pts.length) {
          const keep = new Set<number>([i, j])
          for (let s = 1; s < simplified.length - 1; s++) {
            const idx = refToIdx.get(simplified[s])
            if (idx !== undefined) keep.add(idx)
          }
          const wouldDrop: number[] = []
          for (let k = i + 1; k < j; k++) {
            if (!keep.has(k)) wouldDrop.push(k)
          }
          if (wouldDrop.length > 0) {
            let distinctLeft = 0
            const dropSet = new Set(wouldDrop)
            for (let k = sub.start; k < sub.end; k++) {
              if (k !== sub.seamPartner && !dropped.has(k) && !dropSet.has(k)) {
                distinctLeft += 1
              }
            }
            if (distinctLeft >= minDistinct) {
              for (const k of wouldDrop) dropped.add(k)
              removedAny = true
            }
          }
        }
      }
      i = j > i ? j : i + 1
    }

    for (let k = sub.start; k < sub.end; k++) {
      if (!dropped.has(k)) rebuilt.push({ ...segs[k] })
    }
    if (sub.closed) rebuilt.push({ op: 'Z' })
  }

  return removedAny && rebuilt.length < segs.length ? rebuilt : null
}
