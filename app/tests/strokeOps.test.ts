import assert from 'node:assert/strict'
import test from 'node:test'
import { flattenContours } from '../shared/paths.ts'
import { boxAlignTransform, moveItem, pointsToClosedPath, restrokeFromOutline, roundPt, splitStrokeAtKnife, withMedianPoints } from '../src/lib/strokeOps.ts'
import { rectPath, strokeOf } from './helpers.ts'

test('roundPt·pointsToClosedPath: 소수 첫째 자리로 반올림해 닫힌 경로를 만든다', () => {
  assert.deepEqual(roundPt([1.26, 2.24]), [1.3, 2.2])
  assert.equal(pointsToClosedPath([[0, 0], [10.04, 0], [10, 10.06]]), 'M 0 0 L 10 0 L 10 10.1 Z')
})

test('moveItem: 이동한 새 배열을 주고 범위를 벗어나면 null', () => {
  const list = ['a', 'b', 'c']
  assert.deepEqual(moveItem(list, 0, 1), ['b', 'a', 'c'])
  assert.deepEqual(moveItem(list, 2, -2), ['c', 'a', 'b'])
  assert.equal(moveItem(list, 0, -1), null)
  assert.equal(moveItem(list, 2, 1), null)
  assert.deepEqual(list, ['a', 'b', 'c'], '원본은 바뀌지 않는다')
})

test('withMedianPoints: 중심선을 바꾸고 원본 획은 그대로 둔다', () => {
  const stroke = strokeOf(rectPath(100, 100, 500, 160), [[110, 130], [490, 130]])
  const next = withMedianPoints(stroke, [[110, 130], [300, 130], [490, 130]])
  assert.equal(next.median_points.length, 3)
  assert.equal(stroke.median_points.length, 2)
  assert.equal(next.outline_path, stroke.outline_path)
  assert.ok(next.stroke_width > 0)
})

test('restrokeFromOutline: 새 윤곽에서 중심선·폭을 구하고 나머지 속성은 유지', () => {
  const stroke = strokeOf(rectPath(0, 0, 10, 10), [[1, 1], [9, 9]], { is_radical: 1 })
  const bar = rectPath(100, 100, 500, 160)
  const next = restrokeFromOutline(stroke, bar)
  assert.equal(next.outline_path, bar)
  assert.equal(next.is_radical, 1)
  assert.ok(next.median_points.length >= 2)
  assert.ok(next.median_points.every(([x, y]) => x >= 100 && x <= 500 && y >= 100 && y <= 160))
})

test('boxAlignTransform: 원본 상자를 대상 상자로 옮기고 평균 배율을 준다', () => {
  const { map, scale } = boxAlignTransform({ minX: 100, minY: 100, maxX: 300, maxY: 500 }, { minX: 0, minY: 0, maxX: 100, maxY: 100 })
  assert.deepEqual(map(0, 0), [100, 100])
  assert.deepEqual(map(100, 100), [300, 500])
  assert.equal(scale, 3)
  const flat = boxAlignTransform({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { minX: 5, minY: 5, maxX: 5, maxY: 5 })
  assert.ok(Number.isFinite(flat.scale), '폭 0인 원본 상자도 안전하다')
})

// ㅏ·ㅓ: 세로 막대(x 460~560) 옆에 가로 획이 붙은 모양
const STEM = { minX: 460, maxX: 560, minY: 100, maxY: 920 }
const AH = 'M460 100 L560 100 L560 480 L800 480 L800 560 L560 560 L560 920 L460 920 Z'
const EO = 'M240 480 L460 480 L460 100 L560 100 L560 920 L460 920 L460 560 L240 560 Z'
const KNIFE_TOP = 0
const KNIFE_BOTTOM = 1000
// 래스터화 오차를 감안한 허용 거리
const TOLERANCE = 4

function boundsOf(path: string) {
  const points = flattenContours(path, 1.4)[0]
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

function cutVertically(path: string, x: number) {
  const parts = splitStrokeAtKnife(strokeOf(path, [[0, 0], [1, 1]], { stroke_width: 135 }), [{ x, y: KNIFE_TOP }, { x, y: KNIFE_BOTTOM }])
  assert.ok(parts)
  const isStem = (stroke: { outline_path: string }) => {
    const bounds = boundsOf(stroke.outline_path)
    return bounds.maxY - bounds.minY > STEM.maxY - STEM.minY - TOLERANCE * 2
  }
  const stem = parts.find(isStem)
  const bar = parts.find((part) => !isStem(part))
  assert.ok(stem && bar)
  return { stem, bar }
}

test('칼로 ㅏ를 ㅣ+ㅡ로 나누면 ㅡ의 시작(기필)은 ㅣ 안쪽에 숨은 모양이 되고 ㅣ는 그대로다', () => {
  const { stem, bar } = cutVertically(AH, STEM.maxX)
  assert.equal(bar.start_cap_type, 'AUTO_ROUND')
  assert.equal(bar.end_cap_type, 'NONE')
  const barBounds = boundsOf(bar.outline_path)
  assert.ok(barBounds.minX > STEM.minX && barBounds.minX < STEM.maxX - TOLERANCE, 'ㅡ의 끝점이 ㅣ 안쪽에 있다')
  assert.ok(barBounds.maxY - barBounds.minY < (STEM.maxX - STEM.minX), 'ㅡ가 ㅣ의 세로 길이로 번지지 않고 획 폭을 유지한다')
  assert.equal(stem.start_cap_type, 'NONE')
  assert.equal(stem.end_cap_type, 'NONE')
  const stemBounds = boundsOf(stem.outline_path)
  assert.ok(stemBounds.minX <= STEM.minX + TOLERANCE && stemBounds.maxY >= STEM.maxY - TOLERANCE, 'ㅣ에 파임이 없다')
})

test('칼로 ㅓ를 ㅣ+ㅡ로 나누면 ㅡ의 끝(수필)이 ㅣ 안쪽에 숨은 모양이 된다', () => {
  const { stem, bar } = cutVertically(EO, STEM.minX)
  assert.equal(bar.start_cap_type, 'NONE')
  assert.equal(bar.end_cap_type, 'AUTO_ROUND')
  const barBounds = boundsOf(bar.outline_path)
  assert.ok(barBounds.maxX > STEM.minX + TOLERANCE && barBounds.maxX < STEM.maxX, 'ㅡ의 끝점이 ㅣ 안쪽에 있다')
  assert.equal(stem.start_cap_type, 'NONE')
  assert.equal(stem.end_cap_type, 'NONE')
})

test('칼이 ㅣ의 경계에서 어긋나도(안쪽 4) ㅡ가 ㅣ의 세로 띠를 가져가지 않는다', () => {
  const { stem, bar } = cutVertically(AH, STEM.maxX - TOLERANCE)
  const barBounds = boundsOf(bar.outline_path)
  assert.ok(barBounds.maxY - barBounds.minY < (STEM.maxX - STEM.minX))
  const stemBounds = boundsOf(stem.outline_path)
  assert.ok(stemBounds.maxX >= STEM.maxX - TOLERANCE, 'ㅣ의 오른쪽이 파이지 않는다')
})

test('긴 획을 가운데서 자르면 두 조각의 마주 보는 끝 모두 모양이 붙고, 합치면 원래 폭이 이어진다', () => {
  const long = strokeOf(rectPath(100, 460, 700, 540), [[140, 500], [660, 500]], { stroke_width: 80 })
  const parts = splitStrokeAtKnife(long, [{ x: 400, y: KNIFE_TOP }, { x: 400, y: KNIFE_BOTTOM }])
  assert.ok(parts)
  const [right, left] = parts.slice().sort((a, b) => boundsOf(b.outline_path).minX - boundsOf(a.outline_path).minX)
  assert.equal(left.end_cap_type, 'AUTO_ROUND')
  assert.equal(right.start_cap_type, 'AUTO_ROUND')
  assert.ok(boundsOf(left.outline_path).maxX > 400 && boundsOf(right.outline_path).minX < 400, '두 조각이 서로 겹친다')
})

test('칼이 단면 끝을 만들지 않으면(획과 나란한 칼) 캡은 원본 값을 유지한다', () => {
  const long = strokeOf(rectPath(100, 440, 700, 560), [[140, 500], [660, 500]], { stroke_width: 120, start_cap_type: 'POINTED' })
  const parts = splitStrokeAtKnife(long, [{ x: 0, y: 500 }, { x: 1000, y: 500 }])
  assert.ok(parts)
  assert.deepEqual(parts.map((part) => part.start_cap_type), ['POINTED', 'POINTED'])
})

test('가를 수 없는 칼은 null', () => {
  const stroke = strokeOf(rectPath(100, 100, 500, 160), [[110, 130], [490, 130]])
  assert.equal(splitStrokeAtKnife(stroke, [{ x: 900, y: 0 }, { x: 900, y: 1000 }]), null)
})

test('칼 분할 캡 값: 원본의 시작·끝에서 온 끝만 원본 캡을 물려받는다', () => {
  const long = strokeOf(rectPath(100, 440, 700, 560), [[140, 500], [660, 500]], { stroke_width: 120, start_cap_type: 'POINTED', end_cap_type: 'BULGE' })
  const parts = splitStrokeAtKnife(long, [{ x: 400, y: KNIFE_TOP }, { x: 400, y: KNIFE_BOTTOM }])
  assert.ok(parts)
  const byPosition = parts.slice().sort((a, b) => boundsOf(a.outline_path).minX - boundsOf(b.outline_path).minX)
  assert.deepEqual(byPosition.map((part) => [part.start_cap_type, part.end_cap_type]), [['POINTED', 'AUTO_ROUND'], ['AUTO_ROUND', 'BULGE']],
    '원본의 기필은 왼쪽 조각의 시작, 수필은 오른쪽 조각의 끝으로 가고, 가른 단면에는 새 모양이 붙는다')
})

// ㅐ: 왼 ㅣ(460~540) + 가로(540~640, y 480~560) + 오른 ㅣ(640~720)
const AE = 'M460 100 L540 100 L540 480 L640 480 L640 100 L720 100 L720 920 L640 920 L640 560 L540 560 L540 920 L460 920 Z'
const LEFT_STEM_EDGE = 540
const RIGHT_STEM_EDGE = 640
const RIGHT_STEM_MAX_X = 720

test('ㅐ: 칼 두 번으로 ㅣ·ㅡ·ㅣ를 나누면 ㅡ의 양 끝이 모두 ㅣ 안쪽에 숨은 모양이 된다', () => {
  const first = splitStrokeAtKnife(strokeOf(AE, [[0, 0], [1, 1]], { stroke_width: 135 }), [{ x: LEFT_STEM_EDGE, y: KNIFE_TOP }, { x: LEFT_STEM_EDGE, y: KNIFE_BOTTOM }])
  assert.ok(first)
  assert.equal(first.length, 2)
  const composite = first.find((piece) => boundsOf(piece.outline_path).maxX > RIGHT_STEM_EDGE)
  assert.ok(composite, 'ㅡ와 오른쪽 ㅣ가 붙은 조각')
  assert.ok(boundsOf(composite.outline_path).minX < LEFT_STEM_EDGE - TOLERANCE, '합쳐진 조각에서도 ㅡ의 왼쪽 끝이 왼쪽 ㅣ 안쪽으로 들어간다')
  const second = splitStrokeAtKnife(composite, [{ x: RIGHT_STEM_EDGE, y: KNIFE_TOP }, { x: RIGHT_STEM_EDGE, y: KNIFE_BOTTOM }])
  assert.ok(second)
  const bar = second.find((piece) => boundsOf(piece.outline_path).maxY - boundsOf(piece.outline_path).minY < STEM.maxY - STEM.minY - 200)
  assert.ok(bar)
  const barBounds = boundsOf(bar.outline_path)
  assert.ok(barBounds.minX > STEM.minX && barBounds.minX < LEFT_STEM_EDGE - TOLERANCE, 'ㅡ의 왼쪽 끝이 왼쪽 ㅣ 안쪽에 있다')
  assert.ok(barBounds.maxX > RIGHT_STEM_EDGE + TOLERANCE && barBounds.maxX < RIGHT_STEM_MAX_X, 'ㅡ의 오른쪽 끝이 오른쪽 ㅣ 안쪽에 있다')
  assert.equal(bar.end_cap_type, 'AUTO_ROUND')
})

// ㅍ: 위 가로 y 780~860, 아래 가로 y 180~260(x 200~800), 다리 x 320~400·600~680, 가운데 구멍
const PIEUP = 'M200 860 L800 860 L800 780 L680 780 L680 260 L800 260 L800 180 L200 180 L200 260 L320 260 L320 780 L200 780 Z M400 780 L400 260 L600 260 L600 780 Z'
const TOP_BAR_BOTTOM = 780
const BOTTOM_BAR_TOP = 260
const LEG_MIN_HEIGHT = 400

test('ㅍ: 가로 획을 떼어 내도 두 다리가 모두 남고, 가로 획에는 다리의 캡이 붙지 않는다', () => {
  const first = splitStrokeAtKnife(strokeOf(PIEUP, [[0, 0], [1, 1]], { stroke_width: 135 }), [{ x: 0, y: TOP_BAR_BOTTOM }, { x: 1000, y: TOP_BAR_BOTTOM }])
  assert.ok(first)
  const rest = first.find((piece) => boundsOf(piece.outline_path).minY < BOTTOM_BAR_TOP)
  assert.ok(rest)
  const second = splitStrokeAtKnife(rest, [{ x: 0, y: BOTTOM_BAR_TOP }, { x: 1000, y: BOTTOM_BAR_TOP }])
  assert.ok(second)
  assert.equal(second.length, 3, '아래 가로와 다리 둘')
  const isLeg = (piece: { outline_path: string }) => boundsOf(piece.outline_path).maxY - boundsOf(piece.outline_path).minY > LEG_MIN_HEIGHT
  assert.equal(second.filter(isLeg).length, 2, '두 다리가 모두 남는다')
  const bottomBar = second.find((piece) => !isLeg(piece))
  assert.ok(bottomBar)
  assert.deepEqual([bottomBar.start_cap_type, bottomBar.end_cap_type], ['NONE', 'NONE'], '가로 획 양 끝은 다리의 캡을 물려받지 않는다')
  for (const leg of second.filter(isLeg)) assert.ok(boundsOf(leg.outline_path).maxY > TOP_BAR_BOTTOM, '다리 윗끝이 위 가로 안쪽으로 들어간다')
})
