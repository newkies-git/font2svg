import {
  CANVAS,
  DEFAULT_STROKE_WIDTH,
  MEDIAN_MIN_POINTS,
  MEDIAN_SIMPLIFY_TOLERANCE,
  MIN_STROKE_AREA_RATIO,
} from '../shared/constants.ts'
import { warnOnce } from '../shared/log.ts'
import { round1 } from '../shared/paths.ts'
import { computeOptimalStrokeWidth, recoverMedian, segmentOutlineByMedians, simplifyPolyline } from '../shared/strokeCut.ts'
import type { Pt, StrokeRecord } from '../shared/types.ts'
import {
  boundsOf,
  contourArea,
  contourIndicesOfOutline,
  contourLoopsOf,
  fitMediansToOutline,
  orientLike,
  pathPoints,
  ribbonPath,
  toPoints,
  type ImportedStrokes,
} from './geometry.ts'
import { OLLAMA_MODEL, postOllama } from './ids.ts'

export type OllamaSplitSource = 'NAVER' | 'MMH'

type OllamaSplitStrokePlan = {
  strokeOrder: number
  contourIndices: number[]
  median: Pt[]
}

const OLLAMA_SEED = 1

const OLLAMA_SPLIT_SCHEMA = {
  type: 'object',
  properties: {
    strokes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          strokeOrder: { type: 'integer' },
          contourIndices: { type: 'array', items: { type: 'integer' } },
          median: {
            type: 'array',
            items: { type: 'array', items: { type: 'number' } },
          },
        },
        required: ['strokeOrder', 'contourIndices', 'median'],
      },
    },
  },
  required: ['strokes'],
}

function sanitizeMedian(raw: unknown): Pt[] | null {
  if (!Array.isArray(raw) || raw.length < 2) return null
  const pts: Pt[] = []
  for (const item of raw) {
    if (!Array.isArray(item) || item.length < 2) continue
    const x = Number(item[0])
    const y = Number(item[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    pts.push([
      round1(Math.max(0, Math.min(CANVAS, x))),
      round1(Math.max(0, Math.min(CANVAS, y))),
    ])
  }
  return pts.length >= 2 ? pts : null
}

function summarizeContours(contours: string[]) {
  return contours.map((d, index) => {
    const b = boundsOf(pathPoints(d))
    return {
      index,
      bbox: [Math.round(b.minX), Math.round(b.minY), Math.round(b.maxX), Math.round(b.maxY)],
      center: [Math.round((b.minX + b.maxX) / 2), Math.round((b.minY + b.maxY) / 2)],
    }
  })
}

function summarizeGuide(guideStrokes: Pick<StrokeRecord, 'stroke_order' | 'median_points'>[]) {
  return guideStrokes.map((stroke, idx) => {
    const pts = stroke.median_points
    const b = boundsOf(pts)
    return {
      strokeOrder: stroke.stroke_order || idx + 1,
      start: pts[0] ? [Math.round(pts[0][0]), Math.round(pts[0][1])] : [0, 0],
      end: pts[pts.length - 1] ? [Math.round(pts[pts.length - 1][0]), Math.round(pts[pts.length - 1][1])] : [0, 0],
      points: pts.map(([x, y]) => [Math.round(x), Math.round(y)]),
      bbox: [Math.round(b.minX), Math.round(b.minY), Math.round(b.maxX), Math.round(b.maxY)],
    }
  })
}

async function askOllamaForStrokeSplit(params: {
  char: string
  source: OllamaSplitSource
  contours: string[]
  guideStrokes: Pick<StrokeRecord, 'stroke_order' | 'median_points'>[]
  model?: string
}): Promise<OllamaSplitStrokePlan[] | null> {
  const model = params.model?.trim() || OLLAMA_MODEL
  const contourSummary = summarizeContours(params.contours)
  const guideSummary = summarizeGuide(params.guideStrokes)
  const sourceName = params.source === 'NAVER' ? '네이버 한자사전' : 'Hanzi (Make Me a Hanzi)'

  const prompt = [
    `한자 '${params.char}'의 궁서체 윤곽(contours)을 ${sourceName} 획순(총 ${guideSummary.length}획)에 맞게 분리하려고 한다.`,
    `좌표계는 0~${CANVAS} (x는 왼쪽→오른쪽, y는 아래→위)이다.`,
    `궁서체 윤곽 덩어리(contours): ${JSON.stringify(contourSummary)}`,
    `${sourceName} 기준 획순(${guideSummary.length}획): ${JSON.stringify(guideSummary)}`,
    `각 획(strokeOrder 1..${guideSummary.length})마다 궁서체 윤곽 내부를 지나도록 위치·비율을 보정한 중심선 median([[x,y], ...], 2점 이상)과 해당 획이 속한 궁서체 윤곽 인덱스 배열 contourIndices를 JSON으로 답하라.`,
  ].join('\n')

  try {
    const response = await postOllama('/api/generate', {
      model,
      stream: false,
      think: false,
      format: OLLAMA_SPLIT_SCHEMA,
      options: { temperature: 0, seed: OLLAMA_SEED },
      prompt,
    })
    if (!response.ok) return null
    const data = (await response.json()) as { response?: string }
    const parsed = JSON.parse(data.response ?? '') as { strokes?: unknown }
    if (!Array.isArray(parsed.strokes)) return null

    const plans: OllamaSplitStrokePlan[] = []
    for (const item of parsed.strokes) {
      if (!item || typeof item !== 'object') continue
      const row = item as { strokeOrder?: unknown; contourIndices?: unknown; median?: unknown }
      const strokeOrder = Number(row.strokeOrder)
      const median = sanitizeMedian(row.median)
      if (!Number.isInteger(strokeOrder) || !median) continue
      const contourIndices = Array.isArray(row.contourIndices)
        ? [...new Set(row.contourIndices.map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < params.contours.length)
        : []
      plans.push({ strokeOrder, contourIndices, median })
    }
    return plans.length > 0 ? plans : null
  } catch (error) {
    warnOnce('ollama-split', error)
    return null
  }
}

export async function splitFontByOllamaGuide(params: {
  char: string
  source: OllamaSplitSource
  contours: string[]
  guideStrokes: Pick<StrokeRecord, 'stroke_order' | 'median_points'>[]
  model?: string
}): Promise<ImportedStrokes & { unmatched: number[]; model: string; source: OllamaSplitSource }> {
  const model = params.model?.trim() || OLLAMA_MODEL
  if (params.contours.length === 0) {
    throw new Error('현재 글자에 궁서체 윤곽이 없습니다.')
  }
  if (params.guideStrokes.length === 0) {
    throw new Error(`${params.source === 'NAVER' ? '네이버' : 'Hanzi'} 기준 획순 데이터가 없습니다.`)
  }

  const plans = await askOllamaForStrokeSplit({ ...params, model })
  if (!plans) {
    throw new Error('로컬 Ollama에서 궁서체 획 분리 응답을 받지 못했습니다. Ollama 실행 상태와 모델을 확인하세요.')
  }

  const rawGuideMedians = params.guideStrokes.map((stroke) => stroke.median_points)
  const fittedFallback = fitMediansToOutline(rawGuideMedians, params.contours)
  const byOrder = new Map(plans.map((plan) => [plan.strokeOrder, plan]))
  const targetMedians = params.guideStrokes.map((stroke, idx) => {
    const order = stroke.stroke_order || idx + 1
    return byOrder.get(order)?.median ?? fittedFallback[idx]
  })

  // 어느 contour가 하나의 획에만 단독으로 매핑되었는지 추적 (분할 실패 시 보정용)
  const contourUseCount = new Map<number, number>()
  for (let i = 0; i < params.guideStrokes.length; i++) {
    const order = params.guideStrokes[i].stroke_order || i + 1
    for (const cIdx of byOrder.get(order)?.contourIndices ?? []) {
      contourUseCount.set(cIdx, (contourUseCount.get(cIdx) ?? 0) + 1)
    }
  }

  const split = segmentOutlineByMedians(params.contours, targetMedians.map(toPoints))
  const glyphArea = Math.abs(params.contours.reduce((sum, d) => sum + contourArea(d), 0))
  const whole = new Set(params.contours)
  const contourLoops = contourLoopsOf(params.contours)

  const medians: Pt[][] = []
  const outlines: string[] = []
  const widths: number[] = []
  const unmatched: number[] = []

  for (let index = 0; index < targetMedians.length; index++) {
    const line = targetMedians[index]
    const order = params.guideStrokes[index].stroke_order || index + 1
    let outline = split.strokes[index] ?? ''
    let usable = Boolean(outline) && !whole.has(outline) && Math.abs(contourArea(outline)) >= glyphArea * MIN_STROKE_AREA_RATIO

    // 기하학 분할이 통째 윤곽을 못 쪼갰거나 실패했을 때, Ollama가 단독 contour를 지정했으면 그 윤곽 사용
    if (!usable) {
      const assigned = byOrder.get(order)?.contourIndices ?? []
      if (assigned.length === 1 && contourUseCount.get(assigned[0]) === 1) {
        outline = params.contours[assigned[0]]
        usable = Boolean(outline) && Math.abs(contourArea(outline)) >= glyphArea * MIN_STROKE_AREA_RATIO
      }
    }

    const recovered = usable ? recoverMedian(outline).median : []
    if (recovered.length < MEDIAN_MIN_POINTS) {
      outlines.push(ribbonPath(line, DEFAULT_STROKE_WIDTH))
      medians.push(line)
      widths.push(DEFAULT_STROKE_WIDTH)
      unmatched.push(index + 1)
      continue
    }

    const simplified = simplifyPolyline(orientLike(recovered, line), MEDIAN_SIMPLIFY_TOLERANCE)
    const medianPts = simplified.map((point): Pt => [round1(point.x), round1(point.y)])
    outlines.push(outline)
    medians.push(medianPts)
    widths.push(computeOptimalStrokeWidth(outline, simplified))
    if (contourIndicesOfOutline(outline, contourLoops).length === 0) {
      unmatched.push(index + 1)
    }
  }

  return {
    medians,
    outlines,
    widths,
    fontOutline: params.contours,
    unmatched,
    model,
    source: params.source,
  }
}
