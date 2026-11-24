import {
  DEFAULT_STROKE_WIDTH,
  FIT_CORNER_ANGLE,
  FIT_END_OVERLAP_MAX_RATIO,
  FIT_END_OVERLAP_MIN_RATIO,
  FIT_FLATNESS,
  FIT_GRID,
  FIT_MARGIN,
  FIT_MIN_GAIN,
  MEDIAN_SIMPLIFY_TOLERANCE,
} from '../../shared/constants.ts'
import { assignRegions, CELL, centroidOf, fillMask, IDENTITY, iou, loopsOf, mapFor, optimize, type FitParams, type Loop } from '../../shared/fitCore.ts'
import { flattenContours, round1 } from '../../shared/paths.ts'
import { computeOptimalStrokeWidth, recoverMedian, segmentOutlineByMedians, simplifyPolyline } from '../../shared/strokeCut.ts'
import { smoothMildJoins } from '../../shared/strokeCut/smoothJoins.ts'
import { transformStroke } from '../../shared/vectorEdit.ts'
import type { Pt, StrokeRecord } from '../../shared/types.ts'

// 기존 가져오는 쪽과 시험이 이 파일에서 쓰던 이름을 그대로 쓸 수 있게 공용 구현을 다시 내보낸다.
export { fillMask, iou, iouSpans, spansOf, targetOf } from '../../shared/fitCore.ts'

export type FitResult = {
  strokes: StrokeRecord[]
  // 맞춤 전/후 겹침 비율(IoU, 0~1)
  before: number
  after: number
}

function transformedStroke(stroke: StrokeRecord, p: FitParams, center: Pt): StrokeRecord {
  const scaleFactor = Math.sqrt(Math.abs(p.sx * p.sy))
  return transformStroke(stroke, mapFor(p, center), scaleFactor)
}

// 평탄화한 윤곽에서 방향이 FIT_CORNER_ANGLE 이상 꺾이는 정점 수.
function cornerCount(loops: Loop[]): number {
  let count = 0
  for (const loop of loops) {
    const n = loop.length
    for (let i = 0; i < n; i++) {
      const prev = loop[(i + n - 1) % n]
      const cur = loop[i]
      const next = loop[(i + 1) % n]
      const inAngle = Math.atan2(cur.y - prev.y, cur.x - prev.x)
      const outAngle = Math.atan2(next.y - cur.y, next.x - cur.x)
      let turn = Math.abs(outAngle - inAngle)
      if (turn > Math.PI) turn = 2 * Math.PI - turn
      if (turn >= FIT_CORNER_ANGLE) count++
    }
  }
  return count
}

function strokeLoops(stroke: StrokeRecord): Loop[] {
  return flattenContours(stroke.outline_path, FIT_FLATNESS)
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
      // 접합부 끝 모양의 접선 어긋남(약한 꺾임)을 매끄럽게 이어 변곡점처럼 보이는 정점을 없앤다.
      const snapped: StrokeRecord = { ...stroke, outline_path: smoothMildJoins(path), median_points: median.points, stroke_width: median.width }
      const after = iou(pieceMask ?? fillMask(strokeLoops(snapped)), region)
      // 접합부에서 잘린 조각은 모서리가 새로 생기므로, 원본보다 꺾임이 늘면 원본 윤곽을 변형해 맞춘다.
      if (preserveGuideMedian && cornerCount(loopsOf([path])) > cornerCount(strokeLoops(stroke))) return refineStroke(stroke, region)
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
  const regions = assignRegions(fontMask, strokes.map((stroke) => stroke.median_points))
  const segmented = strokes.length > 1 && fontPaths.filter((path) => path.trim()).length !== strokes.length
  const piece = fontPieces(strokes, fontPaths)[index] ?? ''
  const target = targetRegion(fontMask, regions[index], piece)
  const result = snapStroke(strokes[index], piece, target, segmented)
  return { strokes: strokes.map((s, i) => (i === index ? result.stroke : s)), before: result.before, after: result.after }
}

// 레이어의 획마다 맡은 궁서체 모양으로 윤곽을 바꾼다. 모양을 나누지 못한 획만 위치·크기를 옮긴다.
export function autoFitLayer(strokes: StrokeRecord[], fontPaths: string[]): FitResult {
  const fontMask = fillMask(loopsOf(fontPaths))
  const voronoi = assignRegions(fontMask, strokes.map((stroke) => stroke.median_points))
  const segmented = strokes.length > 1 && fontPaths.filter((path) => path.trim()).length !== strokes.length
  const pieces = fontPieces(strokes, fontPaths)
  const targets = strokes.map((_, i) => targetRegion(fontMask, voronoi[i], pieces[i] ?? ''))
  const before = meanOf(strokes.map((stroke, i) => iou(fillMask(strokeLoops(stroke)), targets[i])))
  const results = strokes.map((stroke, i) => snapStroke(stroke, pieces[i] ?? '', targets[i], segmented))
  const after = meanOf(results.map((result) => result.after))
  return { strokes: results.map((result) => result.stroke), before, after }
}
