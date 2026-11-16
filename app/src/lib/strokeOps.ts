import type { Pt, StrokeRecord } from '../types.ts'
import { round1 } from './paths.ts'
import { recoverMedian } from './strokeCut.ts'
import type { BBox } from './vectorEdit.ts'
import { recomputeStrokeWidth } from './vectorEdit.ts'

// 화면 상태(Vue)에 의존하지 않는 획 편집 계산. useStrokeEdit은 잠금 확인과 상태 반영만 맡는다.

export function roundPt(p: Pt): Pt {
  return [round1(p[0]), round1(p[1])]
}

export function pointsToClosedPath(points: Pt[]): string {
  const pts = points.map(roundPt)
  const [x0, y0] = pts[0]
  let d = `M ${x0} ${y0}`
  for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0]} ${pts[i][1]}`
  return `${d} Z`
}

// items[index]를 delta만큼 옮긴 새 배열. 범위를 벗어나면 null.
export function moveItem<T>(items: T[], index: number, delta: number): T[] | null {
  const next = index + delta
  if (next < 0 || next >= items.length) return null
  const copy = items.slice()
  const [item] = copy.splice(index, 1)
  copy.splice(next, 0, item)
  return copy
}

// 중심선을 바꾸고 새 중심선에 맞게 획 폭을 다시 계산한다.
export function withMedianPoints(stroke: StrokeRecord, points: Pt[]): StrokeRecord {
  return { ...stroke, median_points: points, stroke_width: recomputeStrokeWidth(stroke.outline_path, points, stroke.stroke_width) }
}

// 윤곽이 바뀐 획: 새 윤곽에서 중심선과 폭을 다시 구한다(구하지 못하면 기존 중심선을 유지).
export function restrokeFromOutline(stroke: StrokeRecord, path: string): StrokeRecord {
  const recovered = recoverMedian(path, stroke.stroke_width)
  const points = recovered.median.map((p): Pt => roundPt([p.x, p.y]))
  return {
    ...stroke,
    outline_path: path,
    median_points: points.length >= 2 ? points : stroke.median_points,
    stroke_width: recovered.width,
  }
}

// 원본 상자를 대상 상자에 맞추는 좌표 변환과 평균 배율. 상자 크기가 0이어도 나눗셈이 깨지지 않게 최소 1로 본다.
export function boxAlignTransform(target: BBox, source: BBox): { map: (x: number, y: number) => Pt; scale: number } {
  const sx = (target.maxX - target.minX) / Math.max(1, source.maxX - source.minX)
  const sy = (target.maxY - target.minY) / Math.max(1, source.maxY - source.minY)
  return {
    map: (x, y) => [target.minX + (x - source.minX) * sx, target.minY + (y - source.minY) * sy],
    scale: (sx + sy) / 2,
  }
}
