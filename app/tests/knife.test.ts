import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_STROKE_WIDTH } from '../shared/constants.ts'
import { flattenContours } from '../shared/paths.ts'
import { splitStrokeByKnife } from '../shared/strokeCut.ts'
import { pathBounds } from './helpers.ts'

// ㅏ: 세로 막대(x 460~560)와 그 오른쪽에 붙은 가로 획(x 560~800)
const STEM = { minX: 460, maxX: 560, minY: 100, maxY: 920 }
const BAR = { minX: 560, maxX: 800, minY: 480, maxY: 560 }
const AH = `M${STEM.minX} ${STEM.minY} L${STEM.maxX} ${STEM.minY} L${STEM.maxX} ${BAR.minY} L${BAR.maxX} ${BAR.minY} L${BAR.maxX} ${BAR.maxY} L${STEM.maxX} ${BAR.maxY} L${STEM.maxX} ${STEM.maxY} L${STEM.minX} ${STEM.maxY} Z`
const KNIFE_TOP = 0
const KNIFE_BOTTOM = 1000
// 래스터화 오차(한 칸)를 감안한 허용 거리
const TOLERANCE = 4

function cutAt(x: number): string[] {
  const parts = splitStrokeByKnife(AH, [{ x, y: KNIFE_TOP }, { x, y: KNIFE_BOTTOM }])
  assert.ok(parts)
  assert.equal(parts.length, 2)
  return [parts[0].path, parts[1].path]
}

test('칼이 ㅣ의 경계에 맞으면 ㅣ는 파이지 않고, 두 조각이 접합부에서 서로 겹친다', () => {
  const [bar, stem] = cutAt(STEM.maxX)
  const stemBounds = pathBounds(stem)
  const barBounds = pathBounds(bar)
  assert.ok(stemBounds.minX <= STEM.minX + TOLERANCE && stemBounds.minY <= STEM.minY + TOLERANCE && stemBounds.maxY >= STEM.maxY - TOLERANCE)
  assert.ok(stemBounds.maxX > STEM.maxX + TOLERANCE, 'ㅣ가 ㅡ의 뿌리 쪽으로 넘어가 겹친다')
  assert.ok(barBounds.minX < STEM.maxX - TOLERANCE, 'ㅡ가 ㅣ 안쪽으로 넘어가 겹친다')
  assert.ok(barBounds.maxX >= BAR.maxX - TOLERANCE)
})

test('겹침 깊이는 기본 획 폭의 일부로 제한된다(세로 막대 전체로 번지지 않는다)', () => {
  const [bar] = cutAt(STEM.maxX)
  const barBounds = pathBounds(bar)
  assert.ok(STEM.maxX - barBounds.minX <= DEFAULT_STROKE_WIDTH * 0.2)
  assert.ok(barBounds.maxY - barBounds.minY < (BAR.maxY - BAR.minY) * 2, 'ㅡ 조각이 ㅣ의 길이만큼 늘어나지 않는다')
})

test('칼이 ㅣ의 경계에서 몇 칸 어긋나도 ㅣ에 파임이 남지 않는다', () => {
  for (const x of [STEM.maxX - TOLERANCE, STEM.maxX + TOLERANCE]) {
    const intact = cutAt(x).map(pathBounds).some((bounds) => bounds.minX <= STEM.minX + TOLERANCE && bounds.maxX >= STEM.maxX - TOLERANCE
      && bounds.minY <= STEM.minY + TOLERANCE && bounds.maxY >= STEM.maxY - TOLERANCE)
    assert.ok(intact, `칼 x=${x}`)
  }
})

test('칼에 닿은 구간이 획의 끝이면 단면(face)으로 알려 주고, 긴 변을 따라가면 알리지 않는다', () => {
  const parts = splitStrokeByKnife(AH, [{ x: STEM.maxX, y: KNIFE_TOP }, { x: STEM.maxX, y: KNIFE_BOTTOM }])
  assert.ok(parts)
  const [bar, stem] = parts
  assert.equal(bar.ends.length, 1)
  const [face] = bar.ends
  assert.ok(Math.abs(face.width - (BAR.maxY - BAR.minY)) <= TOLERANCE, `단면 폭 ${face.width}`)
  assert.ok(Math.abs(face.origin.x - STEM.maxX) <= TOLERANCE && Math.abs(face.origin.y - (BAR.minY + BAR.maxY) / 2) <= TOLERANCE)
  assert.deepEqual([Math.sign(face.along.x), Math.round(Math.abs(face.along.y))], [-1, 0], '바깥 방향은 상대 조각(ㅣ) 쪽')
  assert.equal(stem.ends.length, 0, 'ㅣ는 칼이 긴 변을 따라가므로 끝이 아니다')
})

test('칼의 한쪽에서 떨어진 덩어리는 각각 조각이 된다(ㅍ의 두 다리)', () => {
  // 위 가로 y 780~860, 아래 가로 y 180~260(x 200~800), 다리 x 320~400·600~680, 가운데 구멍
  const pieung = 'M200 860 L800 860 L800 780 L680 780 L680 260 L800 260 L800 180 L200 180 L200 260 L320 260 L320 780 L200 780 Z M400 780 L400 260 L600 260 L600 780 Z'
  const upper = splitStrokeByKnife(pieung, [{ x: 0, y: 780 }, { x: 1000, y: 780 }])
  assert.ok(upper)
  assert.equal(upper.length, 2, '위 가로와 (다리+아래 가로)')
  const lower = upper.find((piece) => pathBounds(piece.path).minY < 200)
  assert.ok(lower)
  assert.equal(lower.ends.length, 2, '두 다리의 윗끝이 모두 획의 끝이다')
  const legs = splitStrokeByKnife(lower.path, [{ x: 0, y: 260 }, { x: 1000, y: 260 }])
  assert.ok(legs)
  const boundsList = legs.map((piece) => pathBounds(piece.path))
  assert.equal(legs.length, 3, '아래 가로와 다리 둘')
  assert.equal(boundsList.filter((bounds) => bounds.maxY - bounds.minY > 400).length, 2, '두 다리가 모두 남는다')
})

// 田: 바깥 틀 200~800(두께 80)과 안쪽 十(두께 80), 구멍 4개
const TIAN = 'M200 800 L800 800 L800 200 L200 200 Z M280 540 L460 540 L460 720 L280 720 Z M540 540 L720 540 L720 720 L540 720 Z M280 280 L460 280 L460 460 L280 460 Z M540 280 L720 280 L720 460 L540 460 Z'
const LEFT_SIDE_EDGE = 280
const RIGHT_SIDE_EDGE = 720
const BOTTOM_BAR_TOP = 280
const contourCount = (path: string) => flattenContours(path, 1.4).length

test('고리 모양의 조각은 안쪽 구멍을 잃지 않는다(田의 아래 가로를 떼어 낸 윗부분)', () => {
  const pieces = splitStrokeByKnife(TIAN, [{ x: 0, y: BOTTOM_BAR_TOP }, { x: 1000, y: BOTTOM_BAR_TOP }])
  assert.ok(pieces)
  assert.equal(pieces.length, 2)
  const counts = pieces.map((piece) => contourCount(piece.path)).sort()
  assert.deepEqual(counts, [1, 3], '아래 가로는 구멍 없음, 윗부분은 틀 안에 갇힌 구멍 둘이 남는다(아래 구멍 둘은 칼로 열림)')
})

test('틀의 세로 변을 차례로 떼어 내면 구멍이 열리고, 칼 가장자리에 얇은 띠가 남지 않는다', () => {
  const first = splitStrokeByKnife(TIAN, [{ x: LEFT_SIDE_EDGE, y: 0 }, { x: LEFT_SIDE_EDGE, y: 1000 }])
  assert.ok(first)
  const rest = first.find((piece) => contourCount(piece.path) > 1)
  assert.ok(rest, '왼쪽 변을 떼어 낸 나머지는 오른쪽 구멍 둘을 유지한다')
  assert.equal(contourCount(rest.path), 3)
  const second = splitStrokeByKnife(rest.path, [{ x: RIGHT_SIDE_EDGE, y: 0 }, { x: RIGHT_SIDE_EDGE, y: 1000 }])
  assert.ok(second)
  const inner = second.find((piece) => pathBounds(piece.path).minX < RIGHT_SIDE_EDGE - 100)
  assert.ok(inner)
  assert.equal(contourCount(inner.path), 1, '오른쪽 변까지 떼어 내면 구멍이 모두 열려 윤곽이 하나다(구멍 가장자리 띠가 구멍을 닫지 않는다)')
})

// ㄱ에 세로 획이 매달린 모양: 위 가로(y 720~800), 오른쪽 세로(x 720~800), 가운데 매달린 세로(x 460~540, y 400~720)
const GIYEOK = 'M200 800 L800 800 L800 200 L720 200 L720 720 L540 720 L540 400 L460 400 L460 720 L200 720 Z'
const GIYEOK_INNER_Y = 720
const GIYEOK_INNER_X = 720
const GIYEOK_STEM_TOP = 720

test('꺾인 칼 한 번으로 ㄱ(위 가로 + 오른쪽 세로)이 한 조각으로 나뉜다', () => {
  const pieces = splitStrokeByKnife(GIYEOK, [{ x: 0, y: GIYEOK_INNER_Y }, { x: GIYEOK_INNER_X, y: GIYEOK_INNER_Y }, { x: GIYEOK_INNER_X, y: 0 }])
  assert.ok(pieces)
  assert.equal(pieces.length, 2, 'ㄱ과 매달린 세로, 두 조각')
  const giyeok = pieces.find((piece) => pathBounds(piece.path).minY < 250)
  const stem = pieces.find((piece) => piece !== giyeok)
  assert.ok(giyeok && stem)
  const bounds = pathBounds(giyeok.path)
  assert.ok(bounds.minX <= 200 + TOLERANCE && bounds.maxX >= 800 - TOLERANCE && bounds.maxY >= 800 - TOLERANCE, 'ㄱ이 가로 전체와 바깥 모서리를 가진다')
  assert.ok(bounds.minY <= 200 + TOLERANCE, 'ㄱ이 오른쪽 세로 끝까지 이어진다')
  assert.equal(giyeok.ends.length, 0, 'ㄱ은 칼의 긴 변을 따라 닿으므로 끝 단면이 없다')
  assert.equal(stem.ends.length, 1, '매달린 세로의 윗끝은 획의 끝이다')
  assert.ok(pathBounds(stem.path).maxY > GIYEOK_STEM_TOP + TOLERANCE, '세로의 윗끝이 ㄱ 안쪽으로 들어간다')
})

test('꺾이는 점의 바깥쪽 모서리도 같은 조각에 속한다(ㄱ의 바깥 모서리가 잘리지 않는다)', () => {
  const pieces = splitStrokeByKnife(GIYEOK, [{ x: 0, y: GIYEOK_INNER_Y }, { x: GIYEOK_INNER_X, y: GIYEOK_INNER_Y }, { x: GIYEOK_INNER_X, y: 0 }])
  assert.ok(pieces)
  const containsCorner = pieces.filter((piece) => {
    const bounds = pathBounds(piece.path)
    return bounds.maxX >= 800 - TOLERANCE && bounds.maxY >= 800 - TOLERANCE
  })
  assert.equal(containsCorner.length, 1)
})

test('점이 하나뿐이거나 모두 같은 점이면 칼이 아니다', () => {
  assert.equal(splitStrokeByKnife(GIYEOK, [{ x: 500, y: 500 }]), null)
  assert.equal(splitStrokeByKnife(GIYEOK, [{ x: 500, y: 500 }, { x: 500, y: 500 }]), null)
})

test('면적이 거의 없는 윤곽은 예외 없이 null이다', () => {
  const flat = 'M 0 0 L 100 0 L 50 0 Z'
  assert.equal(splitStrokeByKnife(flat, [{ x: 50, y: -5 }, { x: 50, y: 5 }]), null)
})

test('너무 짧은 칼이나 한쪽이 빈 칼은 null', () => {
  assert.equal(splitStrokeByKnife(AH, [{ x: 500, y: 500 }, { x: 501, y: 501 }]), null)
  assert.equal(splitStrokeByKnife(AH, [{ x: 0, y: 0 }, { x: 0, y: KNIFE_BOTTOM }]), null)
})
