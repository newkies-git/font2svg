import {
  CANVAS,
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
  FIT_FLATNESS,
} from './constants.ts'
import { flattenContours } from './paths.ts'
import type { Pt } from './types.ts'

// 윤곽(점열)을 래스터 격자 위에서 겹침(IoU)으로 맞추는 공용 기반: 화면의 자동 맞춤(autoFit)과 서버의 참고 획 등록(registration)이 같이 쓴다.
export type Loop = { x: number; y: number }[]

// 중심 c 기준 변환: p' = c + R(theta)·S(sx, sy)·H(shear)·(p - c) + (tx, ty)
export type FitParams = { tx: number; ty: number; sx: number; sy: number; theta: number; shear: number }
type ParamKey = keyof FitParams

export const IDENTITY: FitParams = { tx: 0, ty: 0, sx: 1, sy: 1, theta: 0, shear: 0 }
export const CELL = (CANVAS + FIT_MARGIN * 2) / FIT_GRID
const PARAM_KEYS: ParamKey[] = ['tx', 'ty', 'sx', 'sy', 'theta', 'shear']

export function loopsOf(paths: string[]): Loop[] {
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
export type Target = { prefix: Int32Array; count: number }

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

export function centroidOf(loops: Loop[]): Pt {
  let sx = 0
  let sy = 0
  let n = 0
  for (const loop of loops) for (const p of loop) { sx += p.x; sy += p.y; n++ }
  return n === 0 ? [CANVAS / 2, CANVAS / 2] : [sx / n, sy / n]
}

export function mapFor(p: FitParams, c: Pt): (x: number, y: number) => Pt {
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
export function optimize(loops: Loop[], center: Pt, targetMask: Uint8Array, start: FitParams): { params: FitParams; score: number } {
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


function segmentDistanceSq(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / lengthSq))
  const ex = px - (a[0] + t * dx)
  const ey = py - (a[1] + t * dy)
  return ex * ex + ey * ey
}

// 글꼴 칸마다 가장 가까운 중심선을 가진 획에 배정해, 획별 목표 영역(마스크)을 만든다.
export function assignRegions(fontMask: Uint8Array, medians: Pt[][]): Uint8Array[] {
  const regions = medians.map(() => new Uint8Array(fontMask.length))
  for (let i = 0; i < fontMask.length; i++) {
    if (!fontMask[i]) continue
    const px = ((i % FIT_GRID) + 0.5) * CELL - FIT_MARGIN
    const py = (Math.floor(i / FIT_GRID) + 0.5) * CELL - FIT_MARGIN
    let bestIdx = 0
    let bestDist = Infinity
    medians.forEach((pts, s) => {
      for (let j = 0; j < pts.length - 1; j++) {
        const d = segmentDistanceSq(px, py, pts[j], pts[j + 1])
        if (d < bestDist) { bestDist = d; bestIdx = s }
      }
    })
    regions[bestIdx][i] = 1
  }
  return regions
}

