import { AREA_FLATNESS, FIT_GRID, FIT_MARGIN, CANVAS, DEFAULT_STROKE_WIDTH, OUTLINE_CONTOUR_MATCH_RATIO, OUTLINE_CONTOUR_TOLERANCE, MAX_COVERED_AREA_RATIO, MEDIAN_BBOX_INSET, MEDIAN_MIN_POINTS, MEDIAN_SIMPLIFY_TOLERANCE, MIN_COVERED_AREA_RATIO, MIN_STROKE_AREA_RATIO } from '../shared/constants.ts'
import { flattenContours, pointSegmentDistance, polygonArea, round1, type Pt as Point } from '../shared/paths.ts'
import { computeOptimalStrokeWidth, recoverMedian, segmentOutlineByMedians, simplifyPolyline } from '../shared/strokeCut.ts'
import type { Pt } from '../shared/types.ts'
import { CELL, fillMask, loopsOf, type Loop } from '../shared/fitCore.ts'
import { medianTurns } from '../shared/medianShape.ts'
import { registerMedians } from './registration.ts'

export type Box = [number, number, number, number]

export type ImportedStrokes = { medians: Pt[][]; outlines: string[]; widths?: number[]; fontOutline?: string[] }

export const toPoints = (line: Pt[]): Point[] => line.map(([x, y]) => ({ x, y }))

export function contourArea(d: string): number {
  return flattenContours(d, AREA_FLATNESS).reduce((sum, contour) => sum + polygonArea(contour), 0)
}

// 길잡이 중심선의 시작·끝점에 가장 가까운 방향이 되도록 순서를 맞춘다.
export function orientLike(line: Point[], guide: Pt[]): Point[] {
  if (line.length < 2 || guide.length < 2) return line
  const [start, end] = [guide[0], guide[guide.length - 1]]
  const dist = (a: Point, b: Pt) => Math.hypot(a.x - b[0], a.y - b[1])
  const same = dist(line[0], start) + dist(line[line.length - 1], end)
  const flipped = dist(line[0], end) + dist(line[line.length - 1], start)
  return flipped < same ? line.slice().reverse() : line
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

// 길잡이 중심선이 없을 때: 이어진 덩어리(윤곽) 하나를 획 하나로 보고 윤곽에서 중심선과 폭을 되찾는다.
// 어느 덩어리든 중심선을 못 구하면 null이다(일부만 버리면 획이 조용히 사라지기 때문이다).
export function strokesFromComponents(contours: string[]): ImportedStrokes | null {
  const medians: Pt[][] = []
  const widths: number[] = []
  for (const outline of contours) {
    const recovered = recoverMedian(outline).median
    if (recovered.length < MEDIAN_MIN_POINTS) return null
    const line = simplifyPolyline(recovered, MEDIAN_SIMPLIFY_TOLERANCE)
    medians.push(line.map((point): Pt => [round1(point.x), round1(point.y)]))
    widths.push(computeOptimalStrokeWidth(outline, line))
  }
  return { medians, outlines: contours, widths, fontOutline: contours }
}

export type OutlinePiece = {
  outline: string
  median: Pt[]
  width: number
  // 이 획 윤곽이 놓인 궁서체 윤곽(contours)의 인덱스. 비어 있으면 자동 매핑 실패(미매핑)이다.
  contours: number[]
}

// 궁서체 윤곽(contours)을 꼭짓점 목록으로 펼친다. contourIndicesOfOutline에 넘긴다.
export function contourLoopsOf(contours: string[]): Point[][][] {
  return contours.map((d) => flattenContours(d, AREA_FLATNESS))
}

// 획 윤곽의 꼭짓점이 어느 궁서체 윤곽선 위에 놓였는지로 소속 윤곽을 구한다.
export function contourIndicesOfOutline(outline: string, contourLoops: Point[][][]): number[] {
  const vertices = flattenContours(outline, AREA_FLATNESS).flat()
  if (vertices.length === 0) return []
  const result: number[] = []
  contourLoops.forEach((loops, index) => {
    const hits = vertices.filter((vertex) => loops.some((loop) => loop.some((from, i) => (
      pointSegmentDistance(vertex, from, loop[(i + 1) % loop.length]) <= OUTLINE_CONTOUR_TOLERANCE
    )))).length
    if (hits / vertices.length >= OUTLINE_CONTOUR_MATCH_RATIO) result.push(index)
  })
  return result
}

// 길잡이 중심선을 궁서체 윤곽에 맞춘 뒤 획마다 나눈다. 윤곽을 못 찾은 획은 띠 모양으로 남기고 unmatched에 획 번호(1부터)를 넣는다.
// 나눌 수 없으면 null이다. 그 획은 작업 획에서 그대로 편집한다.
export function fitGuideToFont(contours: string[], guide: Pt[][], guideOutlines?: string[]): (ImportedStrokes & { unmatched: number[] }) | null {
  const pieces = splitOutlinePieces(contours, guide, guideOutlines)
  if (!pieces) return null
  return {
    medians: pieces.map((piece) => piece.median),
    outlines: pieces.map((piece) => piece.outline),
    widths: pieces.map((piece) => piece.width),
    fontOutline: contours,
    unmatched: pieces.flatMap((piece, index) => (piece.contours.length === 0 ? [index + 1] : [])),
  }
}

// splitByContours와 달리 품질 검사에 실패해도 전체를 버리지 않고, 윤곽을 못 찾은 획만 contours를 비워(미매핑) 돌려준다.
// 미매핑 획의 윤곽은 길잡이 중심선을 따라 띠 모양으로 만든다. 사람이 나중에 윤곽을 직접 매핑한다.
// 길잡이를 bbox로만 맞춘 결과와 획마다 등록한 결과를 둘 다 나눠 보고, 미매핑 획이 더 적은 쪽을 쓴다(같으면 bbox 쪽).
// guideOutlines는 길잡이 획의 실제 윤곽(굵기를 가진 모양)이다. 주면 등록에서 띠 대신 쓴다.
export function splitOutlinePieces(contours: string[], guide: Pt[][], guideOutlines?: string[]): OutlinePiece[] | null {
  if (contours.length === 0 || guide.length === 0) return null
  const boxFitted = fitMediansToOutline(guide, contours)
  const plain = piecesForGuide(contours, boxFitted)
  if (!plain) return null
  if (unmatchedCount(plain) === 0) return plain
  const registered = piecesForGuide(contours, registerMedians(boxFitted, contours, ribbonPath, guideShapes(guide, contours, guideOutlines)))
  return registered && unmatchedCount(registered) < unmatchedCount(plain) ? registered : plain
}

// 참고 중심선을 윤곽 안쪽 판정에 쓸 때의 표본 간격(글꼴 좌표)과 최소 안쪽 비율
const GUIDE_SAMPLE_STEP = 8
const GUIDE_INSIDE_RATIO = 0.85

// 길잡이 윤곽을 중심선과 같은 bbox 변환으로 옮긴 점열. 윤곽이 없는 획은 빈 배열이다(그 획은 띠로 잰다).
function guideShapes(guide: Pt[][], contours: string[], outlines?: string[]): Loop[][] | undefined {
  const map = bboxMapper(guide, contours)
  if (!map || !outlines || outlines.length !== guide.length) return undefined
  return outlines.map((outline) => (outline ? loopsOf([outline]).map((loop) => loop.map((point) => { const [x, y] = map(point.x, point.y); return { x, y } })) : []))
}

const unmatchedCount = (pieces: OutlinePiece[]): number => pieces.filter((piece) => piece.contours.length === 0).length

// 골격에서 복원한 중심선이 급히 꺾였는데 등록된 참고 중심선(사람이 정한 모양)은 꺾이지 않고 그 획 윤곽 안에 놓여 있으면, 꺾임은 접합부 골격이 휜 잡음이므로 참고 중심선을 쓴다.
export function steadierMedian(recovered: Point[], guideLine: Pt[], outline: string): Point[] {
  if (!medianTurns(recovered.map((point): Pt => [point.x, point.y])).kink || medianTurns(guideLine).kink) return recovered
  return lineInsideOutline(guideLine, outline) ? toPoints(guideLine) : recovered
}

// 선을 일정 간격으로 훑어 윤곽 안쪽에 있는 비율이 GUIDE_INSIDE_RATIO 이상이면 참
function lineInsideOutline(line: Pt[], outline: string): boolean {
  const mask = fillMask(loopsOf([outline]))
  let inside = 0
  let total = 0
  for (let index = 0; index < line.length - 1; index++) {
    const [ax, ay] = line[index]
    const [bx, by] = line[index + 1]
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / GUIDE_SAMPLE_STEP))
    for (let k = 0; k <= steps; k++) {
      const x = ax + ((bx - ax) * k) / steps
      const y = ay + ((by - ay) * k) / steps
      const col = Math.floor((x + FIT_MARGIN) / CELL)
      const row = Math.floor((y + FIT_MARGIN) / CELL)
      total++
      if (col >= 0 && col < FIT_GRID && row >= 0 && row < FIT_GRID && mask[row * FIT_GRID + col]) inside++
    }
  }
  return total > 0 && inside / total >= GUIDE_INSIDE_RATIO
}

function piecesForGuide(contours: string[], fitted: Pt[][]): OutlinePiece[] | null {
  const split = segmentOutlineByMedians(contours, fitted.map(toPoints))
  if (split.strokes.length !== fitted.length) return null
  const glyphArea = Math.abs(contours.reduce((sum, d) => sum + contourArea(d), 0))
  const whole = new Set(contours)
  const contourLoops = contourLoopsOf(contours)
  return fitted.map((line, index): OutlinePiece => {
    const outline = split.strokes[index]
    const usable = Boolean(outline) && !whole.has(outline) && Math.abs(contourArea(outline)) >= glyphArea * MIN_STROKE_AREA_RATIO
    const recovered = usable ? recoverMedian(outline).median : []
    if (recovered.length < MEDIAN_MIN_POINTS) {
      return { outline: ribbonPath(line, DEFAULT_STROKE_WIDTH), median: line, width: DEFAULT_STROKE_WIDTH, contours: [] }
    }
    const simplified = simplifyPolyline(orientLike(recovered, line), MEDIAN_SIMPLIFY_TOLERANCE)
    const median = steadierMedian(simplified, line, outline)
    return {
      outline,
      median: median.map((point): Pt => [round1(point.x), round1(point.y)]),
      width: computeOptimalStrokeWidth(outline, median),
      contours: contourIndicesOfOutline(outline, contourLoops),
    }
  })
}

// 합성한 중심선 묶음의 bbox를 글자 윤곽의 bbox(중심선이 윤곽 안쪽에 있으므로 INSET만큼 줄인 것)에 맞춰 늘이고 옮긴다.
export function fitMediansToOutline(medians: Pt[][], contours: string[]): Pt[][] {
  const map = bboxMapper(medians, contours)
  return map ? medians.map((line) => line.map(([x, y]): Pt => [round1(map(x, y)[0]), round1(map(x, y)[1])])) : medians
}

// 중심선 묶음의 bbox를 글자 윤곽의 bbox에 맞추는 좌표 변환. 맞출 수 없으면 null.
function bboxMapper(medians: Pt[][], contours: string[]): ((x: number, y: number) => Pt) | null {
  const flatMedians = medians.flat()
  const outlinePts = contours.flatMap(pathPoints)
  if (contours.length === 0 || outlinePts.length === 0 || flatMedians.length === 0) return null
  const outline = boundsOf(outlinePts)
  const source = boundsOf(flatMedians)
  const scaleX = (outline.maxX - outline.minX - 2 * MEDIAN_BBOX_INSET) / Math.max(1, source.maxX - source.minX)
  const scaleY = (outline.maxY - outline.minY - 2 * MEDIAN_BBOX_INSET) / Math.max(1, source.maxY - source.minY)
  return (x, y) => [outline.minX + MEDIAN_BBOX_INSET + (x - source.minX) * scaleX, outline.minY + MEDIAN_BBOX_INSET + (y - source.minY) * scaleY]
}

export function pathPoints(d: string): Pt[] {
  const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  const points: Pt[] = []
  for (let index = 0; index + 1 < numbers.length; index += 2) points.push([numbers[index], numbers[index + 1]])
  return points
}

export function boundsOf(points: Pt[]) {
  if (points.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 }
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
