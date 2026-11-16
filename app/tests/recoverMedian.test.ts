import assert from 'node:assert/strict'
import test from 'node:test'
import { computeOptimalStrokeWidth, recoverMedian } from '../shared/strokeCut.ts'
import { MIN_STROKE_WIDTH, STROKE_WIDTH_CAP_RATIO } from '../shared/constants.ts'
import { rectPath } from './helpers.ts'

const first = (median: { x: number; y: number }[]) => median[0]
const last = (median: { x: number; y: number }[]) => median[median.length - 1]

test('가로 획은 왼쪽에서 오른쪽, 세로 획은 위에서 아래로 중심선을 잡는다', () => {
  const horizontal = recoverMedian(rectPath(100, 400, 900, 460)).median
  assert.ok(first(horizontal).x < last(horizontal).x)
  const vertical = recoverMedian(rectPath(400, 100, 460, 900)).median
  assert.ok(first(vertical).y > last(vertical).y, '저장 좌표는 y가 위쪽이라 위(큰 y)에서 시작한다')
})

test('중심선은 윤곽 안쪽을 지나고 폭은 획 두께에 맞는다', () => {
  const { median, width, radii } = recoverMedian(rectPath(100, 400, 900, 480))
  assert.ok(median.every((point) => point.x >= 95 && point.x <= 905 && point.y >= 395 && point.y <= 485))
  assert.equal(radii.length, median.length)
  assert.ok(width >= 80 && width <= 140, `폭 ${width}`)
})

test('윤곽이 비었거나 너무 작으면 빈 중심선과 기본 폭을 돌려준다(예상된 실패라 경고하지 않는다)', () => {
  assert.deepEqual(recoverMedian('', 77), { median: [], width: 77, radii: [] })
  assert.deepEqual(recoverMedian(rectPath(0, 0, 1, 1), 66), { median: [], width: 66, radii: [] })
})

// 본체(T자)와 따로 떨어진 작은 점이 함께 있는 윤곽. 첫 골격 점이 점에 걸려 가장 먼 점 탐색이 한 점에서 끝나는 경우를 만든다.
const T_WITH_SPECK = [
  `${rectPath(0, 560, 40, 600)}`,
  `${rectPath(100, 300, 500, 360)}`,
  `${rectPath(270, 100, 330, 300)}`,
].join(' ')

test('떨어진 점이 섞이거나 갈라진 윤곽에서도 가장 긴 줄기를 중심선으로 잡는다', () => {
  const { median, width } = recoverMedian(T_WITH_SPECK)
  assert.ok(median.length >= 2, '골격이 끊겨도 중심선을 구한다')
  assert.ok(width >= MIN_STROKE_WIDTH)
  const span = Math.hypot(last(median).x - first(median).x, last(median).y - first(median).y)
  assert.ok(span > 150, `줄기 길이 ${Math.round(span)}`)
})

test('ㄱ자·십자처럼 갈라지는 윤곽은 끝점 사이 가장 긴 경로를 잡는다', () => {
  const cross = `${rectPath(100, 400, 900, 460)} ${rectPath(470, 100, 530, 760)}`
  const { median } = recoverMedian(cross)
  assert.ok(median.length >= 2)
  const span = Math.hypot(last(median).x - first(median).x, last(median).y - first(median).y)
  assert.ok(span > 500)
})

test('획 폭 계산: 중심선이 2점 미만이거나 윤곽이 비면 기본값, 한도 안으로 맞춘다', () => {
  assert.equal(computeOptimalStrokeWidth(rectPath(0, 0, 10, 10), [{ x: 1, y: 1 }], 88), 88)
  assert.equal(computeOptimalStrokeWidth('   ', [{ x: 0, y: 0 }, { x: 1, y: 1 }], 88), 88)
  assert.equal(computeOptimalStrokeWidth('M', [{ x: 0, y: 0 }, { x: 1, y: 1 }], 88), 88, '표본이 없으면 기본값')
  const thin = computeOptimalStrokeWidth(rectPath(0, 0, 100, 2), [{ x: 0, y: 1 }, { x: 100, y: 1 }])
  assert.ok(thin >= MIN_STROKE_WIDTH)
  const huge = computeOptimalStrokeWidth(rectPath(0, 0, 5000, 5000), [{ x: 0, y: 0 }, { x: 1, y: 1 }], 100)
  assert.equal(huge, Math.floor(100 * STROKE_WIDTH_CAP_RATIO), '상한은 기본 폭의 배율')
})
