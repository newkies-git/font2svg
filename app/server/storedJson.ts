import { isRecord } from '../shared/guards.ts'
import type { Pt } from '../shared/types.ts'
import type { MedianLine, StrokeOutline } from './model.ts'

// DB의 JSON 열을 읽는 지점. 형식이 어긋난 값은 빈 값으로 덮지 않고 어느 데이터인지 밝혀 던진다
// (빈 값으로 두면 이후 저장이 원본을 덮어쓸 수 있다). 레이어 표시용 JSON은 layerData.ts가 따로 관대하게 읽는다.

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch (cause) {
    throw new Error(`저장된 ${label} 데이터를 읽을 수 없습니다.`, { cause })
  }
}

function invalid(label: string): Error {
  return new Error(`저장된 ${label} 데이터의 형식이 올바르지 않습니다.`)
}

const isPoint = (value: unknown): value is Pt => Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n))

export function parseStringArray(text: string, label: string): string[] {
  const value = parseJson(text, label)
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw invalid(label)
  return value
}

export function parseStrokeOutlines(text: string): StrokeOutline[] {
  const value = parseJson(text, '획 윤곽')
  if (!Array.isArray(value) || !value.every((item) => isRecord(item) && typeof item.order === 'number' && typeof item.path === 'string')) {
    throw invalid('획 윤곽')
  }
  return value as StrokeOutline[]
}

// 캡 종류(start_cap, end_cap)는 읽는 쪽에서 normalizeCap으로 정규화하므로 여기서는 요구하지 않는다.
export function parseMedianLines(text: string): MedianLine[] {
  const value = parseJson(text, '중심선')
  const valid = Array.isArray(value) && value.every((item) => (
    isRecord(item) && typeof item.order === 'number' && typeof item.width === 'number' && Array.isArray(item.points) && item.points.every(isPoint)
  ))
  if (!valid) throw invalid('중심선')
  return value as MedianLine[]
}
