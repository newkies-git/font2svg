import type { Pt } from './types.ts'

// 중심선(꺾은선)의 꺾임을 재는 공용 도구. 추출 품질 측정(server/extractMetrics.ts)과 중심선 선택(server/geometry.ts)이 같이 쓴다.
// 중심선에서 이 각도(도)를 넘는 꺾임은 사람 손으로는 잘 나오지 않는 급한 꺾임으로 본다.
const KINK_ANGLE_DEG = 60
// 이 각도를 넘으면 중심선이 되돌아가는(스파이크) 것으로 본다.
const REVERSAL_ANGLE_DEG = 100
const RADIANS_TO_DEGREES = 180 / Math.PI

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

