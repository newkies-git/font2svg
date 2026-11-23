import type { Pt, StrokeRecord } from '../../shared/types.ts'
import { parseEditablePath } from '../../shared/vectorEdit.ts'

// 캔버스 그리기에 쓰는 순수 계산(화면 상태 없음).

export type BezierNodes = {
  anchors: { segIndex: number; x: number; y: number }[]
  controls: { kind: 'c1' | 'c2'; segIndex: number; x: number; y: number }[]
  lines: { x1: number; y1: number; x2: number; y2: number }[]
}

// 윤곽 경로에서 베지어 편집기가 그릴 앵커 점·제어점·제어선을 뽑는다.
export function bezierNodesOf(d: string | null): BezierNodes {
  const anchors: BezierNodes['anchors'] = []
  const controls: BezierNodes['controls'] = []
  const lines: BezierNodes['lines'] = []
  if (!d) return { anchors, controls, lines }
  const segs = parseEditablePath(d)

  let prevX = 0
  let prevY = 0
  let startX = 0
  let startY = 0

  segs.forEach((seg, idx) => {
    if (seg.op === 'M') {
      anchors.push({ segIndex: idx, x: seg.x, y: seg.y })
      prevX = seg.x
      prevY = seg.y
      startX = seg.x
      startY = seg.y
    } else if (seg.op === 'L') {
      anchors.push({ segIndex: idx, x: seg.x, y: seg.y })
      prevX = seg.x
      prevY = seg.y
    } else if (seg.op === 'Q') {
      lines.push({ x1: prevX, y1: prevY, x2: seg.x1, y2: seg.y1 })
      lines.push({ x1: seg.x, y1: seg.y, x2: seg.x1, y2: seg.y1 })
      controls.push({ kind: 'c1', segIndex: idx, x: seg.x1, y: seg.y1 })
      anchors.push({ segIndex: idx, x: seg.x, y: seg.y })
      prevX = seg.x
      prevY = seg.y
    } else if (seg.op === 'C') {
      lines.push({ x1: prevX, y1: prevY, x2: seg.x1, y2: seg.y1 })
      lines.push({ x1: seg.x, y1: seg.y, x2: seg.x2, y2: seg.y2 })
      controls.push({ kind: 'c1', segIndex: idx, x: seg.x1, y: seg.y1 })
      controls.push({ kind: 'c2', segIndex: idx, x: seg.x2, y: seg.y2 })
      anchors.push({ segIndex: idx, x: seg.x, y: seg.y })
      prevX = seg.x
      prevY = seg.y
    } else if (seg.op === 'Z') {
      prevX = startX
      prevY = startY
    }
  })

  return { anchors, controls, lines }
}

export function medianLength(points: Pt[]): number {
  let length = 0
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  }
  return length
}

// 획 그리기 애니메이션용 점선 길이와 오프셋: 이미 쓴 획은 0, 쓰는 중인 획은 reveal 비율만큼, 아직 안 쓴 획은 전체.
export function strokeDash(stroke: StrokeRecord, index: number, shown: number, reveal: number): { array: number; offset: number } {
  const span = medianLength(stroke.median_points) + stroke.stroke_width
  const offset = index < shown - 1 ? 0 : index === shown - 1 ? span * (1 - reveal) : span
  return { array: span, offset }
}

export function polylinePoints(points: Pt[]): string {
  return points.map((p) => p.join(',')).join(' ')
}

// 윤곽 연결 도구의 점 라벨: 첫 점 '시', 마지막 점 '끝', 나머지는 번호.
export function connectLabel(index: number, total: number): string {
  if (index === 0) return '시'
  if (index === total - 1 && total > 1) return '끝'
  return String(index)
}
