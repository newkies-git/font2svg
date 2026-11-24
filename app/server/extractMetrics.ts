import { DEFAULT_STROKE_WIDTH } from '../shared/constants.ts'
import { flattenContours, polygonArea } from '../shared/paths.ts'
import type { Pt } from '../shared/types.ts'
import { medianTurns } from '../shared/medianShape.ts'
import { fitGuideToFont, fitMediansToOutline } from './geometry.ts'

// 획 추출 품질을 숫자로 재는 측정기. 추출 방식을 바꿀 때 전후를 같은 잣대로 비교하려고 둔다(scripts/benchExtract.ts).
// 사람이 쓴 획과 다른 모양을 가리키는 지표(정점 과다·곡선 없음·중심선 꺾임/되돌림·파편·띠 대체)를 획마다 센다.

// 한 획의 서브패스 중 전체 면적의 이 비율에 못 미치는 것은 파편이다.
const SLIVER_AREA_RATIO = 0.05
// 파편 판정용 곡선 펴기 허용 오차(px).
const SLIVER_FLATNESS = 0.8
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
  // 같은 방향으로 감긴 서브패스가 둘 이상이라 한 획이 여러 조각으로 떨어져 있다.
  fragmented: boolean
  // 추출한 중심선 길이를 bbox로 맞춘 참고 중심선 길이로 나눈 값. 1보다 많이 작으면 획의 시작이나 끝이 잘린 것이다.
  lengthRatio: number
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

// 한 획 윤곽에 서브패스가 둘 이상이고 그중 아주 작은 것이 있으면 파편이 섞인 것이다.
export function hasSliver(path: string): boolean {
  const areas = flattenContours(path, SLIVER_FLATNESS).map((loop) => Math.abs(polygonArea(loop)))
  if (areas.length < 2) return false
  const total = areas.reduce((sum, area) => sum + area, 0)
  return areas.some((area) => area / total < SLIVER_AREA_RATIO)
}

function isFragmented(path: string): boolean {
  const areas = flattenContours(path, SLIVER_FLATNESS).map(polygonArea)
  const total = areas.reduce((sum, area) => sum + area, 0)
  return areas.filter((area) => Math.sign(area) === Math.sign(total)).length > 1
}

export function measureOutline(path: string): Pick<StrokeMeasure, 'vertices' | 'curveRatio'> {
  const { lines, curves } = commandCounts(path)
  const vertices = lines + curves
  return { vertices, curveRatio: vertices === 0 ? 0 : curves / vertices }
}

// 궁서체 윤곽(contours)에 길잡이 중심선(guide)을 맞춰 나눈 결과를 획마다 잰다. 나눌 수 없으면 fitted=false.
export function measureExtraction(char: string, contours: string[], guide: Pt[][], guideOutlines?: string[]): CharMeasure {
  let fit: ReturnType<typeof fitGuideToFont> = null
  try {
    fit = fitGuideToFont(contours, guide, guideOutlines)
  } catch {
    fit = null
  }
  if (!fit) return { char, strokes: [], fitted: false }
  const unmatched = new Set(fit.unmatched)
  const guideLines = fitMediansToOutline(guide, contours)
  const strokes = fit.outlines.map((outline, index): StrokeMeasure => {
    const isUnmatched = unmatched.has(index + 1)
    const ribbon = isUnmatched && fit.widths?.[index] === DEFAULT_STROKE_WIDTH
    return {
      ...measureOutline(outline),
      medianPoints: fit.medians[index].length,
      lengthRatio: polylineLength(fit.medians[index]) / Math.max(MIN_GUIDE_LENGTH, polylineLength(guideLines[index])),
      ...medianTurns(fit.medians[index]),
      sliver: hasSliver(outline),
      fragmented: isFragmented(outline),
      ribbon,
      unmatchedUsable: isUnmatched && !ribbon,
    }
  })
  return { char, strokes, fitted: true }
}

const MIN_GUIDE_LENGTH = 1
// 중심선 길이가 참고의 이 비율에 못 미치면 시작·끝이 잘린 획으로 센다.
const SHORT_LENGTH_RATIO = 0.85
const polylineLength = (line: Pt[]): number => line.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0] - line[index][0], point[1] - line[index][1]), 0)

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
  const mapped = strokes.filter((stroke) => !stroke.ribbon && !stroke.unmatchedUsable)
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
    fragmented: rate(strokes.filter((stroke) => stroke.fragmented).length, strokes.length),
    // 매핑된 획의 중심선 길이 비(추출 ÷ 참고)와 SHORT_LENGTH_RATIO 미만으로 짧은 획
    length: {
      medianRatio: Number(median(mapped.map((stroke) => stroke.lengthRatio)).toFixed(RATIO_DIGITS)),
      short: rate(mapped.filter((stroke) => stroke.lengthRatio < SHORT_LENGTH_RATIO).length, mapped.length),
    },
    ribbon: rate(strokes.filter((stroke) => stroke.ribbon).length, strokes.length),
    charsWithRibbon: rate(charsWith((stroke) => stroke.ribbon), fitted.length),
    unmatchedUsable: rate(strokes.filter((stroke) => stroke.unmatchedUsable).length, strokes.length),
    // 윤곽을 못 찾은 획 전체: 고정 폭 띠(ribbon)와 길잡이 모양으로 남긴 획(unmatchedUsable)의 합
    unmatched: rate(strokes.filter((stroke) => stroke.ribbon || stroke.unmatchedUsable).length, strokes.length),
  }
}
