import { DEFAULT_STROKE_WIDTH, MIN_STROKE_WIDTH, OPACITY_STEPS, STROKE_WIDTH_CAP_RATIO } from './constants.ts'

// 획 폭을 최소~상한(기본 폭의 STROKE_WIDTH_CAP_RATIO배) 사이 정수로 맞춘다. 0이나 숫자가 아니면 기본 폭이다.
export function clampStrokeWidth(value: number): number {
  const max = Math.round(DEFAULT_STROKE_WIDTH * STROKE_WIDTH_CAP_RATIO)
  return Math.max(MIN_STROKE_WIDTH, Math.min(max, Math.round(value) || DEFAULT_STROKE_WIDTH))
}

// 불투명도를 1/OPACITY_STEPS 단위로 반올림해 0~1로 제한한다. 서버 검증과 화면 입력이 같은 규칙을 쓴다.
export function snapOpacity(value: number): number {
  return Math.max(0, Math.min(1, Math.round(value * OPACITY_STEPS) / OPACITY_STEPS))
}
