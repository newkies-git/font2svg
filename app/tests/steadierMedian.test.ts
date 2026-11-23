import assert from 'node:assert/strict'
import test from 'node:test'
import { steadierMedian, toPoints } from '../server/geometry.ts'
import { medianTurns } from '../shared/medianShape.ts'
import type { Pt } from '../shared/types.ts'
import { rectPath } from './helpers.ts'

// 가로 막대: x 100~900, y 460~540
const BAR = rectPath(100, 460, 900, 540)
const STRAIGHT: Pt[] = [[150, 500], [850, 500]]
// 가운데가 급히 꺾인 복원 중심선
const KINKED = toPoints([[150, 500], [400, 500], [450, 540], [500, 500], [850, 500]])

test('중심선 선택: 복원 중심선이 꺾였고 참고선이 곧고 윤곽 안이면 참고선을 쓴다', () => {
  assert.deepEqual(steadierMedian(KINKED, STRAIGHT, BAR), toPoints(STRAIGHT))
})

test('중심선 선택: 복원 중심선이 곧으면 그대로, 참고선이 윤곽 밖이면 복원 중심선의 꺾임을 깎아 쓴다', () => {
  const straightRecovered = toPoints([[150, 500], [850, 500]])
  assert.equal(steadierMedian(straightRecovered, STRAIGHT, BAR), straightRecovered)
  const outside: Pt[] = [[150, 800], [850, 800]]
  const softened = steadierMedian(KINKED, outside, BAR)
  assert.ok(softened.length > KINKED.length)
  assert.deepEqual(softened[0], KINKED[0])
  assert.deepEqual(softened[softened.length - 1], KINKED[KINKED.length - 1])
  assert.equal(medianTurns(softened.map((point): Pt => [point.x, point.y])).kink, false)
})

test('중심선 선택: 참고선도 꺾여 있으면(갈고리 등) 복원 중심선을 쓴다', () => {
  const hooked: Pt[] = [[150, 500], [800, 500], [800, 440]]
  assert.equal(steadierMedian(KINKED, hooked, BAR), KINKED, '참고선도 꺾였으면 깎지 않는다')
})
