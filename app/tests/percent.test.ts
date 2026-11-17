import assert from 'node:assert/strict'
import test from 'node:test'
import { OPACITY_STEPS } from '../shared/constants.ts'
import { fromPercent, OPACITY_SLIDER, toPercent } from '../src/lib/percent.ts'

test('비율과 퍼센트는 서로 바꿀 수 있고 퍼센트는 정수로 반올림한다', () => {
  assert.equal(toPercent(0.65), 65)
  assert.equal(toPercent(0.123), 12)
  assert.equal(toPercent(1), 100)
  assert.equal(fromPercent(65), 0.65)
  assert.equal(fromPercent(toPercent(0.35)), 0.35)
})

test('슬라이더의 한 칸은 서버가 저장하는 불투명도 단위의 배수다', () => {
  assert.equal(OPACITY_SLIDER.max, OPACITY_STEPS, '슬라이더 끝은 불투명도 단위 수와 같다')
  assert.equal(OPACITY_SLIDER.step % (OPACITY_SLIDER.max / OPACITY_STEPS), 0)
})
