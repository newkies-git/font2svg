import {
  DEFAULT_STROKE_WIDTH,
  FIT_END_OVERLAP_MAX_RATIO,
  FIT_END_OVERLAP_MIN_RATIO,
  FIT_FLATNESS,
  FIT_GRID,
  FIT_LEVELS,
  FIT_LIMIT_ANGLE,
  FIT_LIMIT_SCALE,
  FIT_LIMIT_SHEAR,
  FIT_LIMIT_SHIFT,
  FIT_MARGIN,
  FIT_MAX_SWEEPS,
  FIT_MIN_GAIN,
  FIT_STEP_ANGLE,
  FIT_STEP_DECAY,
  FIT_STEP_SCALE,
  FIT_STEP_SHEAR,
  FIT_STEP_SHIFT,
  CANVAS,
  MEDIAN_SIMPLIFY_TOLERANCE,
} from '../../shared/constants.ts'
import { flattenContours, round1 } from '../../shared/paths.ts'
import { computeOptimalStrokeWidth, recoverMedian, segmentOutlineByMedians, simplifyPolyline } from '../../shared/strokeCut.ts'
import { transformStroke } from './vectorEdit.ts'
import type { Pt, StrokeRecord } from '../../shared/types.ts'

type Loop = { x: number; y: number }[]

// 중심 c 기준 변환: p' = c + R(theta)·S(sx, sy)·H(shear)·(p - c) + (tx, ty)
type FitParams = { tx: number; ty: number; sx: number; sy: number; theta: number; shear: number }
type ParamKey = keyof FitParams

const IDENTITY: FitParams = { tx: 0, ty: 0, sx: 1, sy: 1, theta: 0, shear: 0 }
const CELL = (CANVAS + FIT_MARGIN * 2) / FIT_GRID
const PARAM_KEYS: ParamKey[] = ['tx', 'ty', 'sx', 'sy', 'theta', 'shear']

export type FitResult = {
  strokes: StrokeRecord[]
  // 맞춤 전/후 겹침 비율(IoU, 0~1)
  before: number
  after: number
}

function loopsOf(paths: string[]): Loop[] {
  return paths.flatMap((d) => flattenContours(d, FIT_FLATNESS))
}

// 0이 아닌 감김수(nonzero winding) 규칙으로 윤곽 안쪽을 행별 구간으로 구한다.
// 구간은 [시작 칸, 끝 칸] 쌍을 이어 붙인 배열이고(칸 중심이 안쪽이면 포함), 한 행 안에서 서로 겹치지 않는다.
export function spansOf(loops: Loop[]): number[][] {
  const crossings: { x: number; wind: number }[][] = Array.from({ length: FIT_GRID }, () => [])
  const toRow = (y: number) => (y + FIT_MARGIN) / CELL - 0.5
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]
      const b = loop[(i + 1) % loop.length]
      if (a.y === b.y) continue
      const lo = Math.min(a.y, b.y)
      const hi = Math.max(a.y, b.y)
      const r0 = Math.max(0, Math.ceil(toRow(lo)))
      const r1 = Math.min(FIT_GRID - 1, Math.floor(toRow(hi)))
      for (let r = r0; r <= r1; r++) {
        const yc = (r + 0.5) * CELL - FIT_MARGIN
        if (yc < lo || yc >= hi) continue
        crossings[r].push({ x: a.x + ((yc - a.y) / (b.y - a.y)) * (b.x - a.x), wind: b.y > a.y ? 1 : -1 })
      }
    }
  }
  return crossings.map((row) => {
    const spans: number[] = []
    row.sort((p, q) => p.x - q.x)
    let wind = 0
    for (let k = 0; k < row.length - 1; k++) {
      wind += row[k].wind
      if (wind === 0) continue
      const c0 = Math.max(0, Math.ceil((row[k].x + FIT_MARGIN) / CELL - 0.5))
      const c1 = Math.min(FIT_GRID - 1, Math.floor((row[k + 1].x + FIT_MARGIN) / CELL - 0.5))
      if (c1 < c0) continue
      const last = spans.length - 1
      if (last >= 0 && c0 <= spans[last]) spans[last] = Math.max(spans[last], c1)
      else spans.push(c0, c1)
    }
    return spans
  })
}

// 구간을 칸 마스크(안쪽 1)로 칠한다.
export function fillMask(loops: Loop[]): Uint8Array {
  const mask = new Uint8Array(FIT_GRID * FIT_GRID)
  spansOf(loops).forEach((spans, r) => {
    for (let k = 0; k < spans.length; k += 2) mask.fill(1, r * FIT_GRID + spans[k], r * FIT_GRID + spans[k + 1] + 1)
  })
  return mask
}

// 목표 마스크를 구간으로 겹침을 셀 수 있게 한 것: 행마다 칸 누적합과 전체 칸 수.
type Target = { prefix: Int32Array; count: number }

export function targetOf(mask: Uint8Array): Target {
  const stride = FIT_GRID + 1
  const prefix = new Int32Array(FIT_GRID * stride)
  let count = 0
  for (let r = 0; r < FIT_GRID; r++) {
    for (let c = 0; c < FIT_GRID; c++) {
      const on = mask[r * FIT_GRID + c]
      prefix[r * stride + c + 1] = prefix[r * stride + c] + on
      count += on
    }
  }
  return { prefix, count }
}

// 구간 집합과 목표의 IoU. 칸 마스크를 만들지 않고 구간 길이와 누적합만 쓴다.
export function iouSpans(spans: number[][], target: Target): number {
  const stride = FIT_GRID + 1
  let area = 0
  let inter = 0
  for (let r = 0; r < FIT_GRID; r++) {
    const row = spans[r]
    for (let k = 0; k < row.length; k += 2) {
      area += row[k + 1] - row[k] + 1
      inter += target.prefix[r * stride + row[k + 1] + 1] - target.prefix[r * stride + row[k]]
    }
  }
  const union = area + target.count - inter
  return union === 0 ? 0 : inter / union
}

export function iou(a: Uint8Array, b: Uint8Array): number {
  let inter = 0
  let union = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++
    if (a[i] || b[i]) union++
  }
  return union === 0 ? 0 : inter / union
}

function centroidOf(loops: Loop[]): Pt {
  let sx = 0
  let sy = 0
  let n = 0
  for (const loop of loops) for (const p of loop) { sx += p.x; sy += p.y; n++ }
  return n === 0 ? [CANVAS / 2, CANVAS / 2] : [sx / n, sy / n]
}

function mapFor(p: FitParams, c: Pt): (x: number, y: number) => Pt {
  const cos = Math.cos(p.theta)
  const sin = Math.sin(p.theta)
  // M = R · S · H
  const m00 = cos * p.sx
  const m01 = cos * p.sx * p.shear - sin * p.sy
  const m10 = sin * p.sx
  const m11 = sin * p.sx * p.shear + cos * p.sy
  return (x, y) => {
    const dx = x - c[0]
    const dy = y - c[1]
    return [c[0] + m00 * dx + m01 * dy + p.tx, c[1] + m10 * dx + m11 * dy + p.ty]
  }
}

function applyToLoops(loops: Loop[], fn: (x: number, y: number) => Pt): Loop[] {
  return loops.map((loop) => loop.map((pt) => {
    const [x, y] = fn(pt.x, pt.y)
    return { x, y }
  }))
}

function withinLimits(p: FitParams, start: FitParams): boolean {
  return Math.abs(p.tx - start.tx) <= FIT_LIMIT_SHIFT
    && Math.abs(p.ty - start.ty) <= FIT_LIMIT_SHIFT
    && Math.abs(p.sx - start.sx) <= FIT_LIMIT_SCALE
    && Math.abs(p.sy - start.sy) <= FIT_LIMIT_SCALE
    && Math.abs(p.theta - start.theta) <= FIT_LIMIT_ANGLE
    && Math.abs(p.shear - start.shear) <= FIT_LIMIT_SHEAR
    && p.sx > 0.2 && p.sy > 0.2
}

// 좌표 하강법: 매개변수를 하나씩 ±보폭으로 흔들어 IoU가 오르면 받아들이고, 더 오르지 않으면 보폭을 줄인다.
function optimize(loops: Loop[], center: Pt, targetMask: Uint8Array, start: FitParams): { params: FitParams; score: number } {
  const target = targetOf(targetMask)
  const score = (p: FitParams) => iouSpans(spansOf(applyToLoops(loops, mapFor(p, center))), target)
  let best = { ...start }
  let bestScore = score(best)
  const baseSteps: Record<ParamKey, number> = {
    tx: FIT_STEP_SHIFT, ty: FIT_STEP_SHIFT, sx: FIT_STEP_SCALE, sy: FIT_STEP_SCALE, theta: FIT_STEP_ANGLE, shear: FIT_STEP_SHEAR,
  }
  for (let level = 0; level < FIT_LEVELS; level++) {
    const factor = FIT_STEP_DECAY ** level
    for (let sweep = 0; sweep < FIT_MAX_SWEEPS; sweep++) {
      let improved = false
      for (const key of PARAM_KEYS) {
        for (const sign of [1, -1]) {
          const trial = { ...best, [key]: best[key] + sign * baseSteps[key] * factor }
          if (!withinLimits(trial, start)) continue
          const s = score(trial)
          if (s > bestScore + FIT_MIN_GAIN) {
            best = trial
            bestScore = s
            improved = true
            break
          }
        }
      }
      if (!improved) break
    }
  }
  return { params: best, score: bestScore }
}

function transformedStroke(stroke: StrokeRecord, p: FitParams, center: Pt): StrokeRecord {
  const scaleFactor = Math.sqrt(Math.abs(p.sx * p.sy))
  return transformStroke(stroke, mapFor(p, center), scaleFactor)
}

function strokeLoops(stroke: StrokeRecord): Loop[] {
  return flattenContours(stroke.outline_path, FIT_FLATNESS)
}

function segmentDistanceSq(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / lengthSq))
  const ex = px - (a[0] + t * dx)
  const ey = py - (a[1] + t * dy)
  return ex * ex + ey * ey
}

// 궁서체 칸마다 가장 가까운 중심선을 가진 획에 배정해, 획별 목표 영역(마스크)을 만든다.
function assignRegions(fontMask: Uint8Array, strokes: StrokeRecord[]): Uint8Array[] {
  const regions = strokes.map(() => new Uint8Array(fontMask.length))
  for (let i = 0; i < fontMask.length; i++) {
    if (!fontMask[i]) continue
    const px = ((i % FIT_GRID) + 0.5) * CELL - FIT_MARGIN
    const py = (Math.floor(i / FIT_GRID) + 0.5) * CELL - FIT_MARGIN
    let bestIdx = 0
    let bestDist = Infinity
    strokes.forEach((stroke, s) => {
      const pts = stroke.median_points
      for (let j = 0; j < pts.length - 1; j++) {
        const d = segmentDistanceSq(px, py, pts[j], pts[j + 1])
        if (d < bestDist) { bestDist = d; bestIdx = s }
      }
    })
    regions[bestIdx][i] = 1
  }
  return regions
}

function refineStroke(stroke: StrokeRecord, region: Uint8Array): { stroke: StrokeRecord; before: number; after: number } {
  const loops = strokeLoops(stroke)
  const center = centroidOf(loops)
  const before = iou(fillMask(loops), region)
  const fit = optimize(loops, center, region, IDENTITY)
  return fit.score > before ? { stroke: transformedStroke(stroke, fit.params, center), before, after: fit.score } : { stroke, before, after: before }
}

// 새 중심선의 시작을 기존 획의 시작 쪽에 둔다.
function orientLike(points: Pt[], guide: Pt[]): Pt[] {
  if (points.length < 2 || guide.length < 1) return points
  const [gx, gy] = guide[0]
  const first = Math.hypot(points[0][0] - gx, points[0][1] - gy)
  const last = Math.hypot(points[points.length - 1][0] - gx, points[points.length - 1][1] - gy)
  return last < first ? points.slice().reverse() : points
}

// 윤곽에서 중심선을 다시 잡고, 굽은 곳만 점으로 남긴다. 직선은 양 끝 두 점이다.
function medianAlong(path: string, guide: Pt[], width: number): { points: Pt[]; width: number } | null {
  const recovered = recoverMedian(path, width)
  if (recovered.median.length < 2) return null
  const simplified = simplifyPolyline(
    recovered.median.map((point) => ({ x: point.x, y: point.y })),
    MEDIAN_SIMPLIFY_TOLERANCE,
  )
  const points = orientLike(simplified.map((point): Pt => [round1(point.x), round1(point.y)]), guide)
  return points.length >= 2 ? { points, width: recovered.width } : null
}

// 기존 중심선의 정점·중점 중 절반 이상이 분할된 궁서체 조각 위에 놓여 있으면 끝점 보존을 위해 중심선을 유지한다.
function medianCoveredByMask(points: Pt[], mask: Uint8Array): boolean {
  if (points.length < 2) return false
  const samples: Pt[] = [...points]
  for (let i = 0; i < points.length - 1; i++) {
    samples.push([(points[i][0] + points[i + 1][0]) / 2, (points[i][1] + points[i + 1][1]) / 2])
  }
  let hits = 0
  for (const [x, y] of samples) {
    const col = Math.floor((x + FIT_MARGIN) / CELL)
    const row = Math.floor((y + FIT_MARGIN) / CELL)
    let matched = false
    for (let dr = -1; dr <= 1 && !matched; dr++) {
      const nr = row + dr
      if (nr < 0 || nr >= FIT_GRID) continue
      for (let dc = -1; dc <= 1; dc++) {
        const nc = col + dc
        if (nc >= 0 && nc < FIT_GRID && mask[nr * FIT_GRID + nc] === 1) {
          matched = true
          break
        }
      }
    }
    if (matched) hits++
  }
  return hits >= samples.length * 0.5
}

// 획 윤곽을 궁서체에서 그 획이 맡은 모양으로 바꾼다. 중심선은 다획 길잡이가 조각 위에 있으면 유지하고 아니면 윤곽에서 다시 잡는다.
function snapStroke(
  stroke: StrokeRecord,
  piece: string,
  region: Uint8Array,
  preserveGuideMedian: boolean,
): { stroke: StrokeRecord; before: number; after: number } {
  const before = iou(fillMask(strokeLoops(stroke)), region)
  const path = piece.trim()
  if (path) {
    const pieceMask = preserveGuideMedian ? fillMask(loopsOf([path])) : null
    const median =
      pieceMask && stroke.median_points.length >= 2 && medianCoveredByMask(stroke.median_points, pieceMask)
        ? {
            points: stroke.median_points,
            width: computeOptimalStrokeWidth(
              path,
              stroke.median_points.map(([x, y]) => ({ x, y })),
              stroke.stroke_width,
            ),
          }
        : medianAlong(path, stroke.median_points, stroke.stroke_width)
    if (median) {
      const snapped: StrokeRecord = { ...stroke, outline_path: path, median_points: median.points, stroke_width: median.width }
      const after = iou(pieceMask ?? fillMask(strokeLoops(snapped)), region)
      if (after > before + FIT_MIN_GAIN) return { stroke: snapped, before, after }
      if (after >= before - 0.05) return { stroke, before, after: before }
    }
  }
  return refineStroke(stroke, region)
}

function medianCenter(stroke: StrokeRecord): Pt | null {
  const points = stroke.median_points
  if (points.length === 0) return null
  const sum = points.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y] as Pt, [0, 0] as Pt)
  return [sum[0] / points.length, sum[1] / points.length]
}

// 윤곽 수와 획 수가 같으면 중심이 가까운 윤곽을 획에 그대로 붙인다. 벡터가 그대로라 픽셀 차이가 없다.
function matchContours(strokes: StrokeRecord[], paths: string[]): string[] {
  const centers = paths.map((path) => {
    const loops = loopsOf([path])
    return loops.length > 0 ? centroidOf(loops) : null
  })
  const used = new Set<number>()
  return strokes.map((stroke) => {
    const center = medianCenter(stroke)
    let best = -1
    let bestDist = Infinity
    centers.forEach((candidate, index) => {
      if (!candidate || !center || used.has(index)) return
      const dist = (candidate[0] - center[0]) ** 2 + (candidate[1] - center[1]) ** 2
      if (dist < bestDist) {
        bestDist = dist
        best = index
      }
    })
    if (best < 0) return ''
    used.add(best)
    return paths[best]
  })
}

// 획마다 궁서체 윤곽에서 그 획의 모양을 꺼낸다. 획이 하나면 글자 윤곽 전체가 그 획이다.
function fontPieces(strokes: StrokeRecord[], fontPaths: string[]): string[] {
  const paths = fontPaths.filter((path) => path.trim())
  if (strokes.length <= 1) return [paths.join(' ')]
  if (paths.length === strokes.length) return matchContours(strokes, paths)
  const whole = new Set(paths)
  const medians = strokes.map((stroke) => stroke.median_points.map(([x, y]) => ({ x, y })))
  const split = segmentOutlineByMedians(paths, medians, DEFAULT_STROKE_WIDTH, {
    endOverlap: { min: FIT_END_OVERLAP_MIN_RATIO, max: FIT_END_OVERLAP_MAX_RATIO },
  }).strokes
  return strokes.map((_, index) => {
    const piece = split[index] ?? ''
    return whole.has(piece) ? '' : piece
  })
}

// 끝단 겹침으로 상대 획 안까지 확장된 분할 조각은 보로노이 경계와 합집합한 목표 마스크로 평가한다.
function targetRegion(fontMask: Uint8Array, voronoi: Uint8Array, piece: string): Uint8Array {
  const trimmed = piece.trim()
  if (!trimmed) return voronoi
  const pieceMask = fillMask(loopsOf([trimmed]))
  let voronoiCount = 0
  let sharedCount = 0
  let extraCount = 0
  for (let i = 0; i < fontMask.length; i++) {
    const inVoronoi = voronoi[i] === 1
    const inPiece = pieceMask[i] === 1 && fontMask[i] === 1
    if (inVoronoi) voronoiCount++
    if (inVoronoi && inPiece) sharedCount++
    else if (!inVoronoi && inPiece) extraCount++
  }
  if (voronoiCount === 0 || sharedCount < voronoiCount * 0.5 || extraCount > voronoiCount) return voronoi
  const combined = voronoi.slice()
  for (let i = 0; i < fontMask.length; i++) {
    if (pieceMask[i] && fontMask[i]) combined[i] = 1
  }
  return combined
}

const meanOf = (values: number[]) => (values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length)

// 선택한 획 하나의 윤곽을, 그 획이 맡은 궁서체 모양으로 바꾼다.
export function autoFitStroke(strokes: StrokeRecord[], fontPaths: string[], index: number): FitResult {
  const fontMask = fillMask(loopsOf(fontPaths))
  const regions = assignRegions(fontMask, strokes)
  const segmented = strokes.length > 1 && fontPaths.filter((path) => path.trim()).length !== strokes.length
  const piece = fontPieces(strokes, fontPaths)[index] ?? ''
  const target = targetRegion(fontMask, regions[index], piece)
  const result = snapStroke(strokes[index], piece, target, segmented)
  return { strokes: strokes.map((s, i) => (i === index ? result.stroke : s)), before: result.before, after: result.after }
}

// 레이어의 획마다 맡은 궁서체 모양으로 윤곽을 바꾼다. 모양을 나누지 못한 획만 위치·크기를 옮긴다.
export function autoFitLayer(strokes: StrokeRecord[], fontPaths: string[]): FitResult {
  const fontMask = fillMask(loopsOf(fontPaths))
  const voronoi = assignRegions(fontMask, strokes)
  const segmented = strokes.length > 1 && fontPaths.filter((path) => path.trim()).length !== strokes.length
  const pieces = fontPieces(strokes, fontPaths)
  const targets = strokes.map((_, i) => targetRegion(fontMask, voronoi[i], pieces[i] ?? ''))
  const before = meanOf(strokes.map((stroke, i) => iou(fillMask(strokeLoops(stroke)), targets[i])))
  const results = strokes.map((stroke, i) => snapStroke(stroke, pieces[i] ?? '', targets[i], segmented))
  const after = meanOf(results.map((result) => result.after))
  return { strokes: results.map((result) => result.stroke), before, after }
}
