import { DEFAULT_STROKE_WIDTH } from '../shared/constants.ts'
import { flattenContours, polygonArea } from '../shared/paths.ts'
import type { Pt } from '../shared/types.ts'
import { fitGuideToFont } from './geometry.ts'

// 획 추출 품질을 숫자로 재는 측정기. 추출 방식을 바꿀 때 전후를 같은 잣대로 비교하려고 둔다(scripts/benchExtract.ts).
// 사람이 쓴 획과 다른 모양을 가리키는 지표(정점 과다·곡선 없음·중심선 꺾임/되돌림·파편·띠 대체)를 획마다 센다.

// 중심선에서 이 각도(도)를 넘는 꺾임은 사람 손으로는 잘 나오지 않는 급한 꺾임으로 본다.
const KINK_ANGLE_DEG = 60
// 이 각도를 넘으면 중심선이 되돌아가는(스파이크) 것으로 본다.
const REVERSAL_ANGLE_DEG = 100
// 한 획의 서브패스 중 전체 면적의 이 비율에 못 미치는 것은 파편이다.
const SLIVER_AREA_RATIO = 0.05
// 파편 판정용 곡선 펴기 허용 오차(px).
const SLIVER_FLATNESS = 0.8
const RADIANS_TO_DEGREES = 180 / Math.PI
const PERCENT = 100
const PERCENTILE_P90 = 0.9
const RATE_DIGITS = 1
const RATIO_DIGITS = 4

export type StrokeMeasure = {
  vertices: number
  curveRatio: number
  medianPoints: number
  kink: boolean
  reversal: boolean
  sliver: boolean
  // 윤곽을 못 찾아 고정 폭 띠로 대체됐다(추출 실패).
  ribbon: boolean
  // 윤곽을 못 찾았지만 띠가 아니라 쓸 만한 윤곽이 있다.
  unmatchedUsable: boolean
}

export type CharMeasure = { char: string; strokes: StrokeMeasure[]; fitted: boolean }

// 경로 명령 수: 직선(L)과 곡선(C·Q) 개수. 명령 하나가 정점 하나다.
export function commandCounts(path: string): { lines: number; curves: number } {
  return { lines: (path.match(/L/g) ?? []).length, curves: (path.match(/[CQ]/g) ?? []).length }
}

// 세 점 a→b→c에서 진행 방향이 꺾이는 각도(도). 한 점이 겹치면 0.
export function turnAngleDeg(a: Pt, b: Pt, c: Pt): number {
  const [ux, uy] = [b[0] - a[0], b[1] - a[1]]
  const [vx, vy] = [c[0] - b[0], c[1] - b[1]]
  const length = Math.hypot(ux, uy) * Math.hypot(vx, vy)
  if (length === 0) return 0
  return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / length))) * RADIANS_TO_DEGREES
}

export function medianTurns(median: Pt[]): { kink: boolean; reversal: boolean } {
  let kink = false
  let reversal = false
  for (let index = 1; index < median.length - 1; index++) {
    const angle = turnAngleDeg(median[index - 1], median[index], median[index + 1])
    if (angle > KINK_ANGLE_DEG) kink = true
    if (angle > REVERSAL_ANGLE_DEG) reversal = true
  }
  return { kink, reversal }
}

// 한 획 윤곽에 서브패스가 둘 이상이고 그중 아주 작은 것이 있으면 파편이 섞인 것이다.
export function hasSliver(path: string): boolean {
  const areas = flattenContours(path, SLIVER_FLATNESS).map((loop) => Math.abs(polygonArea(loop)))
  if (areas.length < 2) return false
  const total = areas.reduce((sum, area) => sum + area, 0)
  return areas.some((area) => area / total < SLIVER_AREA_RATIO)
}

export function measureOutline(path: string): Pick<StrokeMeasure, 'vertices' | 'curveRatio'> {
  const { lines, curves } = commandCounts(path)
  const vertices = lines + curves
  return { vertices, curveRatio: vertices === 0 ? 0 : curves / vertices }
}

// 궁서체 윤곽(contours)에 길잡이 중심선(guide)을 맞춰 나눈 결과를 획마다 잰다. 나눌 수 없으면 fitted=false.
export function measureExtraction(char: string, contours: string[], guide: Pt[][]): CharMeasure {
  let fit: ReturnType<typeof fitGuideToFont> = null
  try {
    fit = fitGuideToFont(contours, guide)
  } catch {
    fit = null
  }
  if (!fit) return { char, strokes: [], fitted: false }
  const unmatched = new Set(fit.unmatched)
  const strokes = fit.outlines.map((outline, index): StrokeMeasure => {
    const isUnmatched = unmatched.has(index + 1)
    const ribbon = isUnmatched && fit.widths?.[index] === DEFAULT_STROKE_WIDTH
    return {
      ...measureOutline(outline),
      medianPoints: fit.medians[index].length,
      ...medianTurns(fit.medians[index]),
      sliver: hasSliver(outline),
      ribbon,
      unmatchedUsable: isUnmatched && !ribbon,
    }
  })
  return { char, strokes, fitted: true }
}

const median = (values: number[]): number => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
const percentile90 = (values: number[]): number => {
  if (values.length === 0) return 0
  return [...values].sort((a, b) => a - b)[Math.floor(values.length * PERCENTILE_P90)]
}
const rate = (count: number, total: number): { count: number; total: number; percent: number } => ({
  count,
  total,
  percent: total === 0 ? 0 : Number(((PERCENT * count) / total).toFixed(RATE_DIGITS)),
})
const mean = (values: number[]): number => (values.length === 0 ? 0 : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(RATIO_DIGITS)))

// 글자별 측정을 하나의 보고용 요약으로 모은다. reference는 사람이 그린 참고 윤곽(NAVER)의 같은 지표다.
export function summarizeExtraction(measures: CharMeasure[], reference: { vertices: number[]; curveRatios: number[]; medians: Pt[][] }) {
  const fitted = measures.filter((item) => item.fitted)
  const strokes = fitted.flatMap((item) => item.strokes)
  const charsWith = (test: (stroke: StrokeMeasure) => boolean) => fitted.filter((item) => item.strokes.some(test)).length
  return {
    chars: { sampled: measures.length, fitted: fitted.length, rejected: measures.length - fitted.length },
    strokes: strokes.length,
    reference: {
      medianVertices: median(reference.vertices),
      meanCurveRatio: mean(reference.curveRatios),
      // 사람이 정한 참고 중심선에도 갈고리 등으로 급한 꺾임이 있다. 추출 결과의 꺾임·되돌림은 이 값과 견준다.
      kink: rate(reference.medians.filter((line) => medianTurns(line).kink).length, reference.medians.length),
      reversal: rate(reference.medians.filter((line) => medianTurns(line).reversal).length, reference.medians.length),
    },
    outline: {
      medianVertices: median(strokes.map((stroke) => stroke.vertices)),
      p90Vertices: percentile90(strokes.map((stroke) => stroke.vertices)),
      meanCurveRatio: mean(strokes.map((stroke) => stroke.curveRatio)),
    },
    median: {
      medianPoints: median(strokes.map((stroke) => stroke.medianPoints)),
      kink: rate(strokes.filter((stroke) => stroke.kink).length, strokes.length),
      reversal: rate(strokes.filter((stroke) => stroke.reversal).length, strokes.length),
      charsWithReversal: rate(charsWith((stroke) => stroke.reversal), fitted.length),
    },
    sliver: rate(strokes.filter((stroke) => stroke.sliver).length, strokes.length),
    ribbon: rate(strokes.filter((stroke) => stroke.ribbon).length, strokes.length),
    charsWithRibbon: rate(charsWith((stroke) => stroke.ribbon), fitted.length),
    unmatchedUsable: rate(strokes.filter((stroke) => stroke.unmatchedUsable).length, strokes.length),
  }
}
