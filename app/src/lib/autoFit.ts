import {
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
  FIT_REFINE_ROUNDS,
  FIT_STEP_ANGLE,
  FIT_STEP_DECAY,
  FIT_STEP_SCALE,
  FIT_STEP_SHEAR,
  FIT_STEP_SHIFT,
  CANVAS,
} from './constants.ts'
import { flattenContours } from './paths.ts'
import { transformStroke } from './vectorEdit.ts'
import type { Pt, StrokeRecord } from '../types.ts'

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

// 0이 아닌 감김수(nonzero winding) 규칙으로 윤곽 안쪽 칸을 채운다. 칸 중심이 안쪽이면 1.
function fillMask(loops: Loop[]): Uint8Array {
  const mask = new Uint8Array(FIT_GRID * FIT_GRID)
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
  for (let r = 0; r < FIT_GRID; r++) {
    const row = crossings[r].sort((p, q) => p.x - q.x)
    let wind = 0
    for (let k = 0; k < row.length - 1; k++) {
      wind += row[k].wind
      if (wind === 0) continue
      const c0 = Math.max(0, Math.ceil((row[k].x + FIT_MARGIN) / CELL - 0.5))
      const c1 = Math.min(FIT_GRID - 1, Math.floor((row[k + 1].x + FIT_MARGIN) / CELL - 0.5))
      for (let c = c0; c <= c1; c++) mask[r * FIT_GRID + c] = 1
    }
  }
  return mask
}

function iou(a: Uint8Array, b: Uint8Array): number {
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
function optimize(loops: Loop[], center: Pt, target: Uint8Array, start: FitParams): { params: FitParams; score: number } {
  const score = (p: FitParams) => iou(fillMask(applyToLoops(loops, mapFor(p, center))), target)
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

const meanOf = (values: number[]) => (values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length)

// 선택한 획 하나를, 그 획이 맡은 궁서체 영역에 맞춘다.
export function autoFitStroke(strokes: StrokeRecord[], fontPaths: string[], index: number): FitResult {
  const fontMask = fillMask(loopsOf(fontPaths))
  const regions = assignRegions(fontMask, strokes)
  const result = refineStroke(strokes[index], regions[index])
  return { strokes: strokes.map((s, i) => (i === index ? result.stroke : s)), before: result.before, after: result.after }
}

// 레이어 전체: 먼저 글자 전체 면적에 맞는 아핀 변환을 구하고, 이어서 획마다 영역을 다시 배정하며 보정한다.
export function autoFitLayer(strokes: StrokeRecord[], fontPaths: string[]): FitResult {
  const fontMask = fillMask(loopsOf(fontPaths))
  const allLoops = strokes.flatMap(strokeLoops)
  const center = centroidOf(allLoops)
  const beforeRegions = assignRegions(fontMask, strokes)
  const before = meanOf(strokes.map((stroke, i) => iou(fillMask(strokeLoops(stroke)), beforeRegions[i])))
  const global = optimize(allLoops, center, fontMask, IDENTITY)
  let current = global.score > iou(fillMask(allLoops), fontMask) ? strokes.map((s) => transformedStroke(s, global.params, center)) : strokes

  for (let round = 0; round < FIT_REFINE_ROUNDS; round++) {
    const regions = assignRegions(fontMask, current)
    current = current.map((stroke, i) => refineStroke(stroke, regions[i]).stroke)
  }
  const finalRegions = assignRegions(fontMask, current)
  const after = meanOf(current.map((stroke, i) => iou(fillMask(strokeLoops(stroke)), finalRegions[i])))
  return { strokes: current, before, after }
}

// 화면 표시용: 전/후 겹침을 모두 "획별 평균"으로 비교하기 위한 측정값
export function strokeOverlapScore(strokes: StrokeRecord[], fontPaths: string[]): number {
  const fontMask = fillMask(loopsOf(fontPaths))
  const regions = assignRegions(fontMask, strokes)
  return meanOf(strokes.map((stroke, i) => iou(fillMask(strokeLoops(stroke)), regions[i])))
}
