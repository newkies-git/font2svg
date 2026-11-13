import { COORD_DECIMALS, COORD_ROUND, DEFAULT_STROKE_WIDTH, MEDIAN_MIN_POINTS, MIN_STROKE_WIDTH, STROKE_WIDTH_CAP_RATIO } from './constants.ts'
import { parseCommands, pathBBox } from './paths.ts'
import { computeOptimalStrokeWidth, recoverMedian } from './strokeCut.ts'
import type { Pt, StrokeRecord } from '../types.ts'

export type BBox = { minX: number; minY: number; maxX: number; maxY: number }

export type EditableSeg =
  | { op: 'M'; x: number; y: number }
  | { op: 'L'; x: number; y: number }
  | { op: 'Q'; x1: number; y1: number; x: number; y: number }
  | { op: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { op: 'Z' }

export type HandleRef =
  | { kind: 'anchor'; segIndex: number }
  | { kind: 'c1'; segIndex: number }
  | { kind: 'c2'; segIndex: number }

function r1(v: number): number {
  return Math.round(v * COORD_ROUND) / COORD_ROUND
}

function fmt(v: number): string {
  const n = r1(v)
  return Number.isInteger(n) ? String(n) : n.toFixed(COORD_DECIMALS)
}

export function parseEditablePath(d: string): EditableSeg[] {
  return parseCommands(d).map((cmd): EditableSeg => {
    if (cmd.op === 'M') return { op: 'M', x: r1(cmd.n[0]), y: r1(cmd.n[1]) }
    if (cmd.op === 'L') return { op: 'L', x: r1(cmd.n[0]), y: r1(cmd.n[1]) }
    if (cmd.op === 'Q') return { op: 'Q', x1: r1(cmd.n[0]), y1: r1(cmd.n[1]), x: r1(cmd.n[2]), y: r1(cmd.n[3]) }
    if (cmd.op === 'C') return { op: 'C', x1: r1(cmd.n[0]), y1: r1(cmd.n[1]), x2: r1(cmd.n[2]), y2: r1(cmd.n[3]), x: r1(cmd.n[4]), y: r1(cmd.n[5]) }
    return { op: 'Z' }
  })
}

export function serializeEditablePath(segs: EditableSeg[]): string {
  return segs
    .map((s) => {
      if (s.op === 'M') return `M ${fmt(s.x)} ${fmt(s.y)}`
      if (s.op === 'L') return `L ${fmt(s.x)} ${fmt(s.y)}`
      if (s.op === 'Q') return `Q ${fmt(s.x1)} ${fmt(s.y1)} ${fmt(s.x)} ${fmt(s.y)}`
      if (s.op === 'C') return `C ${fmt(s.x1)} ${fmt(s.y1)} ${fmt(s.x2)} ${fmt(s.y2)} ${fmt(s.x)} ${fmt(s.y)}`
      return 'Z'
    })
    .join(' ')
}

// Photoshop Direct Selection과 동일하게 앵커를 옮기면 해당 앵커에 붙은 인접 제어점(in/out handle)도 함께 평행이동한다.
// 닫힌 서브패스에서 시작점(M)과 마지막 곡선 끝점이 일치하면 함께 움직여 틈이 벌어지지 않게 한다.
export function moveEditableHandle(segs: EditableSeg[], handle: HandleRef, to: Pt): EditableSeg[] {
  const next = segs.map((s) => ({ ...s }))
  const target = next[handle.segIndex]
  if (!target || target.op === 'Z') return next

  if (handle.kind === 'c1' && (target.op === 'Q' || target.op === 'C')) {
    target.x1 = r1(to[0])
    target.y1 = r1(to[1])
    return next
  }
  if (handle.kind === 'c2' && target.op === 'C') {
    target.x2 = r1(to[0])
    target.y2 = r1(to[1])
    return next
  }
  if (handle.kind === 'anchor') {
    const dx = to[0] - target.x
    const dy = to[1] - target.y
    const oldX = target.x
    const oldY = target.y
    target.x = r1(to[0])
    target.y = r1(to[1])
    if (target.op === 'C') {
      target.x2 = r1(target.x2 + dx)
      target.y2 = r1(target.y2 + dy)
    }
    const after = next[handle.segIndex + 1]
    if (after && (after.op === 'Q' || after.op === 'C')) {
      after.x1 = r1(after.x1 + dx)
      after.y1 = r1(after.y1 + dy)
    }
    // 서브패스의 시작점(M)과 닫힘 직전 끝점이 같은 좌표였다면 함께 맞춰 닫힌 윤곽을 유지한다.
    if (target.op === 'M') {
      for (let i = handle.segIndex + 1; i < next.length; i++) {
        const s = next[i]
        if (s.op === 'M') break
        if (s.op === 'Z') {
          const prev = next[i - 1]
          if (prev && prev.op !== 'Z' && prev.op !== 'M' && Math.hypot(prev.x - oldX, prev.y - oldY) < 0.5) {
            prev.x = target.x
            prev.y = target.y
            if (prev.op === 'C') {
              prev.x2 = r1(prev.x2 + dx)
              prev.y2 = r1(prev.y2 + dy)
            }
          }
          break
        }
      }
    }
  }
  return next
}

export function transformPath(d: string, fn: (x: number, y: number) => Pt): string {
  const segs = parseEditablePath(d).map((s): EditableSeg => {
    if (s.op === 'M' || s.op === 'L') {
      const [x, y] = fn(s.x, s.y)
      return { op: s.op, x: r1(x), y: r1(y) }
    }
    if (s.op === 'Q') {
      const [x1, y1] = fn(s.x1, s.y1)
      const [x, y] = fn(s.x, s.y)
      return { op: 'Q', x1: r1(x1), y1: r1(y1), x: r1(x), y: r1(y) }
    }
    if (s.op === 'C') {
      const [x1, y1] = fn(s.x1, s.y1)
      const [x2, y2] = fn(s.x2, s.y2)
      const [x, y] = fn(s.x, s.y)
      return { op: 'C', x1: r1(x1), y1: r1(y1), x2: r1(x2), y2: r1(y2), x: r1(x), y: r1(y) }
    }
    return { op: 'Z' }
  })
  return serializeEditablePath(segs)
}

export function transformStroke(stroke: StrokeRecord, fn: (x: number, y: number) => Pt, scaleFactor = 1): StrokeRecord {
  const maxWidth = Math.round(DEFAULT_STROKE_WIDTH * STROKE_WIDTH_CAP_RATIO)
  const scaledWidth = Math.max(MIN_STROKE_WIDTH, Math.min(maxWidth, Math.round(stroke.stroke_width * scaleFactor)))
  return {
    ...stroke,
    outline_path: transformPath(stroke.outline_path, fn),
    median_points: stroke.median_points.map(([x, y]): Pt => {
      const [nx, ny] = fn(x, y)
      return [r1(nx), r1(ny)]
    }),
    stroke_width: scaledWidth,
  }
}

export function pathsBBox(paths: string[]): BBox | null {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const d of paths) {
    const b = pathBBox(d)
    if (!b) continue
    if (b.minX < minX) minX = b.minX
    if (b.minY < minY) minY = b.minY
    if (b.maxX > maxX) maxX = b.maxX
    if (b.maxY > maxY) maxY = b.maxY
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
}

export function strokesBBox(strokes: StrokeRecord[]): BBox | null {
  const fromPaths = pathsBBox(strokes.map((s) => s.outline_path).filter(Boolean))
  if (fromPaths) return fromPaths
  const pts = strokes.flatMap((s) => s.median_points)
  if (pts.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of pts) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

// 선분들 중 클릭 지점과 가장 가까운 선분을 찾아 그 사이에 새 중심선 정점을 끼워 넣는다.
export function insertMedianPoint(points: Pt[], at: Pt): { points: Pt[]; insertedIndex: number } {
  if (points.length < 2) {
    const next: Pt[] = [...points, [r1(at[0]), r1(at[1])]]
    return { points: next, insertedIndex: next.length - 1 }
  }
  let bestSeg = 0
  let bestDist = Infinity
  for (let i = 0; i < points.length - 1; i++) {
    const d = pointToSegmentDist(at, points[i], points[i + 1])
    if (d < bestDist) {
      bestDist = d
      bestSeg = i
    }
  }
  const copy = points.map((p): Pt => [p[0], p[1]])
  copy.splice(bestSeg + 1, 0, [r1(at[0]), r1(at[1])])
  return { points: copy, insertedIndex: bestSeg + 1 }
}

export function removeMedianPoint(points: Pt[], index: number): Pt[] {
  if (points.length <= MEDIAN_MIN_POINTS) return points
  return points.filter((_, i) => i !== index)
}

export function reverseMedian(points: Pt[]): Pt[] {
  return points.slice().reverse().map(([x, y]): Pt => [x, y])
}

export function recomputeStrokeWidth(outlinePath: string, medianPoints: Pt[], fallback: number): number {
  if (!outlinePath.trim() || medianPoints.length < MEDIAN_MIN_POINTS) return fallback
  try {
    return computeOptimalStrokeWidth(
      outlinePath,
      medianPoints.map(([x, y]) => ({ x, y })),
    )
  } catch {
    return fallback
  }
}

// 두 획을 병합하고 병합된 윤곽에서 중심선과 폭을 다시 복원한다.
export function mergeTwoStrokes(first: StrokeRecord, second: StrokeRecord): StrokeRecord {
  const combinedPath = `${first.outline_path.trim()} ${second.outline_path.trim()}`.trim()
  const recovered = recoverMedian(combinedPath, Math.max(first.stroke_width, second.stroke_width))
  const fallbackMedian: Pt[] = [...first.median_points, ...second.median_points]
  const rawMedian: Pt[] = recovered.median.length >= MEDIAN_MIN_POINTS
    ? recovered.median.map((p): Pt => [r1(p.x), r1(p.y)])
    : fallbackMedian
  // 첫 획의 기필(시작점)에 가까운 쪽이 시작점이 되도록 방향을 맞춘다.
  const start = first.median_points[0]
  const endDist = start ? Math.hypot(rawMedian[rawMedian.length - 1][0] - start[0], rawMedian[rawMedian.length - 1][1] - start[1]) : 0
  const startDist = start ? Math.hypot(rawMedian[0][0] - start[0], rawMedian[0][1] - start[1]) : 0
  const oriented = start && endDist < startDist ? reverseMedian(rawMedian) : rawMedian
  return {
    stroke_order: first.stroke_order,
    outline_path: combinedPath,
    median_points: oriented,
    stroke_width: recovered.width || Math.max(first.stroke_width, second.stroke_width),
    is_radical: (first.is_radical || second.is_radical) ? 1 : 0,
    start_cap_type: first.start_cap_type,
    end_cap_type: second.end_cap_type,
  }
}

function pointToSegmentDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p[0] - a[0], p[1] - a[1])
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}
