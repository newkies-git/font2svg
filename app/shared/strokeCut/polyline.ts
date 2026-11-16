import type { Pt } from '../paths.ts'

// 칼과 획 추출이 쓰는 꺾인 선(점 둘 이상을 이은 선) 계산. 처음·끝 선분은 양쪽으로 무한히 연장한다.
// 안내선(칼 선) 한 선분. start는 칼 선 처음부터 이 선분 시작까지의 길이다. 법선은 (uy, -ux)이고 이쪽이 '왼쪽'이다.
export type KnifeSegment = { a: Pt; ux: number; uy: number; length: number; start: number }

export function knifeSegments(points: readonly Pt[]): KnifeSegment[] {
  const segments: KnifeSegment[] = []
  let start = 0
  for (let i = 0; i + 1 < points.length; i++) {
    const dx = points[i + 1].x - points[i].x
    const dy = points[i + 1].y - points[i].y
    const length = Math.hypot(dx, dy)
    if (length === 0) continue
    segments.push({ a: points[i], ux: dx / length, uy: dy / length, length, start })
    start += length
  }
  return segments
}

// 선을 따라 잰 위치(길이)가 속한 선분. 처음·끝 선분 바깥(연장선)은 처음·끝 선분으로 본다.
export function segmentAt(segments: KnifeSegment[], along: number): KnifeSegment {
  for (let i = segments.length - 1; i > 0; i--) if (along >= segments[i].start) return segments[i]
  return segments[0]
}

// 점 (x, y)에서 선까지의 부호 있는 거리(양수가 왼쪽)와 가장 가까운 점의 칼을 따라 잰 위치.
// 처음·끝 선분은 양쪽으로 무한히 연장한다. 꺾이는 점이 가장 가까우면 이웃한 두 선분의 법선을 더해 어느 쪽인지 정한다.
export function locate(segments: KnifeSegment[], x: number, y: number): { signed: number; along: number } {
  const last = segments.length - 1
  let nearest = Infinity
  let result = { signed: 0, along: 0 }
  for (let i = 0; i <= last; i++) {
    const segment = segments[i]
    const projected = (x - segment.a.x) * segment.ux + (y - segment.a.y) * segment.uy
    const t = Math.min(i === last ? Infinity : segment.length, Math.max(i === 0 ? -Infinity : 0, projected))
    const cx = segment.a.x + segment.ux * t
    const cy = segment.a.y + segment.uy * t
    const distance = Math.hypot(x - cx, y - cy)
    if (distance >= nearest) continue
    nearest = distance
    let nx = segment.uy
    let ny = -segment.ux
    if (i > 0 && t === 0) {
      nx += segments[i - 1].uy
      ny -= segments[i - 1].ux
    } else if (i < last && t === segment.length) {
      nx += segments[i + 1].uy
      ny -= segments[i + 1].ux
    }
    result = { signed: (x - cx) * nx + (y - cy) * ny >= 0 ? distance : -distance, along: segment.start + t }
  }
  return result
}
