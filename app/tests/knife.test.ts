import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_STROKE_WIDTH } from '../shared/constants.ts'
import { flattenContours } from '../shared/paths.ts'
import { splitStrokeByKnife } from '../shared/strokeCut.ts'

// ㅏ: 세로 막대(x 460~560)와 그 오른쪽에 붙은 가로 획(x 560~800)
const STEM = { minX: 460, maxX: 560, minY: 100, maxY: 920 }
const BAR = { minX: 560, maxX: 800, minY: 480, maxY: 560 }
const AH = `M${STEM.minX} ${STEM.minY} L${STEM.maxX} ${STEM.minY} L${STEM.maxX} ${BAR.minY} L${BAR.maxX} ${BAR.minY} L${BAR.maxX} ${BAR.maxY} L${STEM.maxX} ${BAR.maxY} L${STEM.maxX} ${STEM.maxY} L${STEM.minX} ${STEM.maxY} Z`
const KNIFE_TOP = 0
const KNIFE_BOTTOM = 1000
// 래스터화 오차(한 칸)를 감안한 허용 거리
const TOLERANCE = 4

function boundsOf(path: string) {
  const points = flattenContours(path, 1.4)[0]
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

function cutAt(x: number): [string, string] {
  const parts = splitStrokeByKnife(AH, { x, y: KNIFE_TOP }, { x, y: KNIFE_BOTTOM })
  assert.ok(parts)
  return parts
}

test('칼이 ㅣ의 경계에 맞으면 ㅣ는 파이지 않고, 두 조각이 접합부에서 서로 겹친다', () => {
  const [bar, stem] = cutAt(STEM.maxX)
  const stemBounds = boundsOf(stem)
  const barBounds = boundsOf(bar)
  assert.ok(stemBounds.minX <= STEM.minX + TOLERANCE && stemBounds.minY <= STEM.minY + TOLERANCE && stemBounds.maxY >= STEM.maxY - TOLERANCE)
  assert.ok(stemBounds.maxX > STEM.maxX + TOLERANCE, 'ㅣ가 ㅡ의 뿌리 쪽으로 넘어가 겹친다')
  assert.ok(barBounds.minX < STEM.maxX - TOLERANCE, 'ㅡ가 ㅣ 안쪽으로 넘어가 겹친다')
  assert.ok(barBounds.maxX >= BAR.maxX - TOLERANCE)
})

test('겹침 깊이는 기본 획 폭의 일부로 제한된다(세로 막대 전체로 번지지 않는다)', () => {
  const [bar] = cutAt(STEM.maxX)
  const barBounds = boundsOf(bar)
  assert.ok(STEM.maxX - barBounds.minX <= DEFAULT_STROKE_WIDTH * 0.2)
  assert.ok(barBounds.maxY - barBounds.minY < (BAR.maxY - BAR.minY) * 2, 'ㅡ 조각이 ㅣ의 길이만큼 늘어나지 않는다')
})

test('칼이 ㅣ의 경계에서 몇 칸 어긋나도 ㅣ에 파임이 남지 않는다', () => {
  for (const x of [STEM.maxX - TOLERANCE, STEM.maxX + TOLERANCE]) {
    const intact = cutAt(x).map(boundsOf).some((bounds) => bounds.minX <= STEM.minX + TOLERANCE && bounds.maxX >= STEM.maxX - TOLERANCE
      && bounds.minY <= STEM.minY + TOLERANCE && bounds.maxY >= STEM.maxY - TOLERANCE)
    assert.ok(intact, `칼 x=${x}`)
  }
})

test('너무 짧은 칼이나 한쪽이 빈 칼은 null', () => {
  assert.equal(splitStrokeByKnife(AH, { x: 500, y: 500 }, { x: 501, y: 501 }), null)
  assert.equal(splitStrokeByKnife(AH, { x: 0, y: 0 }, { x: 0, y: KNIFE_BOTTOM }), null)
})
