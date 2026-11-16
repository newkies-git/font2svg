import { DEFAULT_STROKE_WIDTH, MIN_STROKE_WIDTH, OPACITY_STEPS, STROKE_WIDTH_CAP_RATIO } from '../src/lib/constants.ts'
import { warnOnce } from '../src/lib/log.ts'
import { isValidSvgPath } from '../src/lib/paths.ts'
import type { LayerColor, Pt, StrokeRecord } from '../src/types.ts'
import { ribbonPath, roundPoints } from './geometry.ts'
import { normalizeCap } from './model.ts'

// 레이어 입력(요청 본문)과 저장된 JSON(character_layers)을 검증·정규화한다. 레이어 조립과 저장 로직은 layers.ts에 있다.
const FONT_HASH_RE = /^[0-9a-f]+$/
const VALID_COLORS = new Set<LayerColor>(['none', 'ink', 'slate', 'blue', 'violet', 'green', 'amber', 'rose'])

function clampStrokeWidth(value: number): number {
  const max = Math.round(DEFAULT_STROKE_WIDTH * STROKE_WIDTH_CAP_RATIO)
  return Math.max(MIN_STROKE_WIDTH, Math.min(max, Math.round(value) || DEFAULT_STROKE_WIDTH))
}

export function clampOpacity(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(1, Math.round(n * OPACITY_STEPS) / OPACITY_STEPS))
}

export function normalizeColor(value: unknown, fallback: LayerColor): LayerColor {
  return typeof value === 'string' && VALID_COLORS.has(value as LayerColor) ? (value as LayerColor) : fallback
}

export function sanitizeLayerStrokes(raw: unknown): StrokeRecord[] {
  if (!Array.isArray(raw)) throw new Error('획 목록 형식이 올바르지 않습니다.')
  return raw.map((item, index) => {
    const stroke = item as Partial<StrokeRecord>
    if (!Array.isArray(stroke.median_points) || stroke.median_points.length < 2) {
      throw new Error(`${index + 1}획의 중심선은 2점 이상이어야 합니다.`)
    }
    const median = roundPoints(stroke.median_points as Pt[])
    const outline = typeof stroke.outline_path === 'string' && stroke.outline_path.trim()
      ? stroke.outline_path.trim()
      : ribbonPath(median, stroke.stroke_width ?? DEFAULT_STROKE_WIDTH)
    if (!isValidSvgPath(outline)) {
      throw new Error(`${index + 1}획의 SVG 외곽선 경로가 올바르지 않습니다.`)
    }
    const record: StrokeRecord = {
      stroke_order: index + 1,
      outline_path: outline,
      median_points: median,
      stroke_width: clampStrokeWidth(Number(stroke.stroke_width ?? DEFAULT_STROKE_WIDTH)),
      is_radical: stroke.is_radical ? 1 : 0,
      start_cap_type: normalizeCap(stroke.start_cap_type),
      end_cap_type: normalizeCap(stroke.end_cap_type),
    }
    if (Array.isArray(stroke.font_contours)) {
      record.font_contours = [...new Set(stroke.font_contours.filter((i) => Number.isInteger(i) && i >= 0))].sort((a, b) => a - b)
      record.map_manual = stroke.map_manual ? 1 : 0
      if (typeof stroke.font_hash === 'string' && FONT_HASH_RE.test(stroke.font_hash)) record.font_hash = stroke.font_hash
    }
    return record
  })
}

export function sanitizeLayerPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error('윤곽 경로 목록 형식이 올바르지 않습니다.')
  return raw.map((entry, index) => {
    const path = String(entry ?? '').trim()
    if (!isValidSvgPath(path)) throw new Error(`${index + 1}번째 윤곽 경로가 올바르지 않습니다.`)
    return path
  })
}

// character_layers에 저장된 JSON을 읽는 유일한 지점. 형식이 어긋난 값(손상·이전 버전)은 화면 전체를 깨뜨리지 않도록
// 경고만 남기고 해당 레이어를 비운다. 획은 최소한 윤곽 문자열과 중심선 배열이 있어야 한다.
function parseStoredJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    warnOnce(`layers-${label}`, error)
    return null
  }
}

function isStoredStroke(value: unknown): value is StrokeRecord {
  if (typeof value !== 'object' || value === null) return false
  const stroke = value as Partial<StrokeRecord>
  return typeof stroke.outline_path === 'string' && Array.isArray(stroke.median_points)
}

export function parseStoredStrokes(text: string): StrokeRecord[] {
  const value = parseStoredJson(text, 'strokes')
  if (Array.isArray(value) && value.every(isStoredStroke)) return value
  if (value !== null) warnOnce('layers-strokes', new Error('저장된 레이어 획 형식이 올바르지 않습니다.'))
  return []
}

export function parseStoredPaths(text: string): string[] {
  const value = parseStoredJson(text, 'paths')
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  if (value !== null) warnOnce('layers-paths', new Error('저장된 레이어 윤곽 형식이 올바르지 않습니다.'))
  return []
}
