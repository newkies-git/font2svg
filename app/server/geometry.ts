import { AREA_FLATNESS, CANVAS, COORD_ROUND, MAX_COVERED_AREA_RATIO, MEDIAN_BBOX_INSET, MEDIAN_MIN_POINTS, MEDIAN_SIMPLIFY_TOLERANCE, MIN_COVERED_AREA_RATIO, MIN_STROKE_AREA_RATIO } from '../src/lib/constants.ts'
import { flattenContours, type Pt as Point } from '../src/lib/paths.ts'
import { computeOptimalStrokeWidth, recoverMedian, segmentOutlineByMedians, simplifyPolyline } from '../src/lib/strokeCut.ts'
import type { Pt } from '../src/types.ts'

export type Box = [number, number, number, number]

export type ImportedStrokes = { medians: Pt[][]; outlines: string[]; widths?: number[]; fontOutline?: string[] }

const toPoints = (line: Pt[]): Point[] => line.map(([x, y]) => ({ x, y }))

function contourArea(d: string): number {
  return flattenContours(d, AREA_FLATNESS).reduce((sum, contour) => {
    let twice = 0
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i]
      const b = contour[(i + 1) % contour.length]
      twice += a.x * b.y - b.x * a.y
    }
    return sum + twice / 2
  }, 0)
}

// 길잡이 중심선의 시작점에 가까운 쪽을 시작으로 맞춘다.
function orientLike(line: Point[], guide: Pt[]): Point[] {
  const [gx, gy] = guide[0]
  const first = Math.hypot(line[0].x - gx, line[0].y - gy)
  const last = Math.hypot(line[line.length - 1].x - gx, line[line.length - 1].y - gy)
  return last < first ? line.slice().reverse() : line
}

// 글자 윤곽(contours)을 길잡이 중심선(guide)으로 획마다 나누고, 획마다 중심선을 새 윤곽에서 다시 구한다.
// 어느 획이든 윤곽을 못 찾았거나(전체 윤곽 그대로), 너무 작거나, 획 면적의 합이 글자 면적의 0.85~1.7배를 벗어나면 null.
export function splitByContours(contours: string[], guide: Pt[][]): ImportedStrokes | null {
  const fitted = fitMediansToOutline(guide, contours)
  const split = segmentOutlineByMedians(contours, fitted.map(toPoints))
  if (split.strokes.length !== fitted.length) return null
  const glyphArea = Math.abs(contours.reduce((sum, d) => sum + contourArea(d), 0))
  const whole = new Set(contours)
  const medians: Pt[][] = []
  const widths: number[] = []
  let covered = 0
  for (let index = 0; index < fitted.length; index++) {
    const outline = split.strokes[index]
    if (!outline || whole.has(outline)) return null
    const area = Math.abs(contourArea(outline))
    if (area < glyphArea * MIN_STROKE_AREA_RATIO) return null
    covered += area
    const recovered = recoverMedian(outline).median
    if (recovered.length < MEDIAN_MIN_POINTS) return null
    const line = simplifyPolyline(orientLike(recovered, fitted[index]), MEDIAN_SIMPLIFY_TOLERANCE)
    medians.push(line.map((point): Pt => [round1(point.x), round1(point.y)]))
    widths.push(computeOptimalStrokeWidth(outline, line))
  }
  if (covered < glyphArea * MIN_COVERED_AREA_RATIO || covered > glyphArea * MAX_COVERED_AREA_RATIO) return null
  return { medians, outlines: split.strokes, widths, fontOutline: contours }
}

// 합성한 중심선 묶음의 bbox를 글자 윤곽의 bbox(중심선이 윤곽 안쪽에 있으므로 INSET만큼 줄인 것)에 맞춰 늘이고 옮긴다.
function fitMediansToOutline(medians: Pt[][], contours: string[]): Pt[][] {
  const outline = boundsOf(contours.flatMap(pathPoints))
  const source = boundsOf(medians.flat())
  const scaleX = (outline.maxX - outline.minX - 2 * MEDIAN_BBOX_INSET) / Math.max(1, source.maxX - source.minX)
  const scaleY = (outline.maxY - outline.minY - 2 * MEDIAN_BBOX_INSET) / Math.max(1, source.maxY - source.minY)
  return medians.map((line) => line.map(([x, y]): Pt => [
    round1(outline.minX + MEDIAN_BBOX_INSET + (x - source.minX) * scaleX),
    round1(outline.minY + MEDIAN_BBOX_INSET + (y - source.minY) * scaleY),
  ]))
}

function pathPoints(d: string): Pt[] {
  const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  const points: Pt[] = []
  for (let index = 0; index + 1 < numbers.length; index += 2) points.push([numbers[index], numbers[index + 1]])
  return points
}

function boundsOf(points: Pt[]) {
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

// 부품 글자의 모든 획 중심선을 한 덩어리로 보고 box(0~1 비율)에 맞춘다. 획마다 따로 맞추면 모든 획이 box 전체로 늘어난다.
export function fitMedians(medians: Pt[][], box: Box): Pt[][] {
  const { minX, maxX, minY, maxY } = boundsOf(medians.flat())
  const [x0, y0, x1, y1] = box
  return medians.map((median) => median.map(([x, y]): Pt => [
    round1((x0 + ((x - minX) / Math.max(1, maxX - minX)) * (x1 - x0)) * CANVAS),
    round1((y0 + ((y - minY) / Math.max(1, maxY - minY)) * (y1 - y0)) * CANVAS),
  ]))
}

export function ribbonPath(median: Pt[], width: number): string {
  const left: Pt[] = []
  const right: Pt[] = []
  const radius = width / 2
  for (let i = 0; i < median.length; i++) {
    const prev = median[Math.max(0, i - 1)]
    const next = median[Math.min(median.length - 1, i + 1)]
    const len = Math.hypot(next[0] - prev[0], next[1] - prev[1]) || 1
    const nx = -(next[1] - prev[1]) / len
    const ny = (next[0] - prev[0]) / len
    left.push([median[i][0] + nx * radius, median[i][1] + ny * radius])
    right.push([median[i][0] - nx * radius, median[i][1] - ny * radius])
  }
  const points = [...left, ...right.reverse()]
  return `M${points.map((point) => `${round1(point[0])} ${round1(point[1])}`).join(' L')} Z`
}

export function roundPoints(points: Pt[]): Pt[] {
  return points.map(([x, y]) => [round1(x), round1(y)])
}

function round1(value: number): number {
  return Math.round(value * COORD_ROUND) / COORD_ROUND
}
