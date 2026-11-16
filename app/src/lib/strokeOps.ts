import type { CapType, KnifeMode, Pt, StrokeRecord } from '../../shared/types.ts'
import { round1 } from '../../shared/paths.ts'
import { applyCapAtFace, applyCapShape, capLength, extractStrokeAlongGuide, isCapShape, KNIFE_OVERLAP, matchMedianEnd, recoverMedian, splitStrokeByKnife, type CapShape } from '../../shared/strokeCut.ts'
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

// 칼로 자른 단면 끝에 기본으로 붙이는 기필·수필 모양
const KNIFE_CUT_CAP: CapShape = 'AUTO_ROUND'

// 조각의 끝점이 원본 획의 시작·끝점 근처(조각 폭의 이 배수 이내)일 때만 그 끝의 캡을 물려받는다.
const CAP_INHERIT_REACH_RATIO = 2

// 가른 조각의 끝(point)이 원본의 어느 끝에서 왔는지 거리로 찾아 그 끝의 캡을 돌려준다. 어느 끝에서도 오지 않았으면 기본.
function inheritedCap(original: StrokeRecord, point: Pt, reach: number): CapType {
  const first = original.median_points[0]
  const last = original.median_points[original.median_points.length - 1]
  if (!first || !last) return 'NONE'
  const fromStart = Math.hypot(point[0] - first[0], point[1] - first[1])
  const fromEnd = Math.hypot(point[0] - last[0], point[1] - last[1])
  if (Math.min(fromStart, fromEnd) > reach) return 'NONE'
  return fromStart <= fromEnd ? original.start_cap_type : original.end_cap_type
}

// 새 윤곽으로 만든 조각 획: 중심선·폭을 다시 구하고, 캡은 원본의 시작·끝에서 온 끝만 원본 값을 물려받는다.
// 조각은 원본의 캡을 통째로 물려받지 않는다(ㅍ의 가로 획이 다리의 캡을 갖지 않게).
function pieceOf(stroke: StrokeRecord, path: string): StrokeRecord {
  const base = restrokeFromOutline(stroke, path)
  const reach = base.stroke_width * CAP_INHERIT_REACH_RATIO
  return {
    ...base,
    start_cap_type: inheritedCap(stroke, base.median_points[0], reach),
    end_cap_type: inheritedCap(stroke, base.median_points[base.median_points.length - 1], reach),
  }
}

// 칼 선(점 둘 이상을 이은 꺾인 선)으로 획을 가른다. 선의 한쪽에서 떨어진 덩어리가 여럿이면 덩어리마다 획이 된다(ㅍ의 두 다리).
// 가른 단면이 획의 끝(기필·수필)인 조각은 상대 조각 안쪽으로 모양 길이만큼 더 깊이 겹치게 하고, 그 끝에 기본 모양을 붙인다.
// 예: ㅏ의 ㅡ는 기필, ㅓ의 ㅡ는 수필, ㅐ의 ㅡ는 양쪽 끝. 매끄러운 단면 대신 시작·끝 형태를 갖되 모양은 상대 조각 안에 숨는다.
// 모양은 윤곽에 반영되고, 그 끝이 중심선의 시작·끝으로 확인될 때만 캡 값을 기록한다. 가를 수 없으면 null.
export function splitStrokeAtKnife(stroke: StrokeRecord, knife: readonly { x: number; y: number }[]): StrokeRecord[] | null {
  const pieces = splitStrokeByKnife(stroke.outline_path, knife, {
    endOverlap: (width) => KNIFE_OVERLAP + capLength(KNIFE_CUT_CAP, width),
  })
  if (!pieces) return null
  return pieces.map((piece) => {
    let record = pieceOf(stroke, piece.path)
    for (const face of piece.ends) {
      const outline = applyCapAtFace(record.outline_path, face, KNIFE_CUT_CAP, false)
      if (!outline) continue
      const end = matchMedianEnd(record.median_points, face)
      record = { ...record, outline_path: outline, ...(end ? { [end === 'start' ? 'start_cap_type' : 'end_cap_type']: KNIFE_CUT_CAP } : {}) }
    }
    return record
  })
}

// 안내선을 따라 획을 뽑는다(교차 분리). 안내선에 닿은 획이 먼저, 나머지가 뒤에 온다. 교차부는 두 쪽이 함께 가진다.
// 예: 十를 가로 안내선으로 뽑으면 ―와, 교차부를 포함한 ㅣ 둘이 된다. 뽑을 수 없으면 null.
export function extractStrokeAtGuide(stroke: StrokeRecord, guide: readonly { x: number; y: number }[]): StrokeRecord[] | null {
  const extracted = extractStrokeAlongGuide(stroke.outline_path, guide)
  if (!extracted) return null
  return [...extracted.stroke, ...extracted.rest].map((path) => pieceOf(stroke, path))
}

// 칼 선(자르기)이나 안내선(교차 분리)으로 윤곽 경로 하나를 나눈다. 나눌 수 없으면 null. 교차 분리는 안내선에 닿은 획이 먼저 온다.
export function separatePath(path: string, knife: readonly { x: number; y: number }[], mode: KnifeMode): string[] | null {
  if (mode === 'extract') {
    const extracted = extractStrokeAlongGuide(path, knife)
    return extracted ? [...extracted.stroke, ...extracted.rest] : null
  }
  return splitStrokeByKnife(path, knife)?.map((piece) => piece.path) ?? null
}

// 칼 선(자르기)이나 안내선(교차 분리)으로 획 하나를 나눈다. 나눌 수 없으면 null.
export function separateStroke(stroke: StrokeRecord, knife: readonly { x: number; y: number }[], mode: KnifeMode): StrokeRecord[] | null {
  return mode === 'extract' ? extractStrokeAtGuide(stroke, knife) : splitStrokeAtKnife(stroke, knife)
}

// 획의 기필(start)·수필(end) 모양을 value로 바꾼 새 획. 모양을 윤곽에 반영해야 하는데 적용할 수 없으면 null이다.
// 모양(둥글게 등)은 그 끝의 윤곽에 반영하고, 모양에서 기본(NONE)으로 돌아오면 끝을 되돌린다. 도장·직접 그리기는 값만 바꾼다.
export function withCap(stroke: StrokeRecord, end: 'start' | 'end', value: CapType): StrokeRecord | null {
  const key = end === 'start' ? 'start_cap_type' : 'end_cap_type'
  const restore = isCapShape(stroke[key])
  if (!isCapShape(value) && !(value === 'NONE' && restore)) return { ...stroke, [key]: value }
  const outline = applyCapShape(stroke.outline_path, stroke.median_points, end, isCapShape(value) ? value : null, stroke.stroke_width, restore)
  return outline ? { ...stroke, outline_path: outline, [key]: value } : null
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
