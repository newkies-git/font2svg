import assert from 'node:assert/strict'
import test from 'node:test'
import { DEFAULT_STROKE_WIDTH, MIN_STROKE_WIDTH, OPACITY_STEPS, STROKE_WIDTH_CAP_RATIO } from '../shared/constants.ts'
import { clampStrokeWidth, snapOpacity } from '../shared/clamp.ts'

test('획 폭은 최소~기본 폭의 상한 배율 사이로 맞추고 소수는 반올림한다', () => {
  const cap = Math.round(DEFAULT_STROKE_WIDTH * STROKE_WIDTH_CAP_RATIO)
  assert.equal(clampStrokeWidth(MIN_STROKE_WIDTH - 1), MIN_STROKE_WIDTH)
  assert.equal(clampStrokeWidth(cap + 1), cap)
  assert.equal(clampStrokeWidth(100.4), 100)
  assert.equal(clampStrokeWidth(100.5), 101)
})

test('0이나 숫자가 아닌 획 폭은 기본 폭이 된다', () => {
  assert.equal(clampStrokeWidth(0), DEFAULT_STROKE_WIDTH)
  assert.equal(clampStrokeWidth(Number.NaN), DEFAULT_STROKE_WIDTH)
})

test('불투명도는 1/OPACITY_STEPS 단위로 반올림하고 0~1로 제한한다', () => {
  assert.equal(snapOpacity(0.123), Math.round(0.123 * OPACITY_STEPS) / OPACITY_STEPS)
  assert.equal(snapOpacity(-0.2), 0)
  assert.equal(snapOpacity(1.7), 1)
  assert.equal(snapOpacity(0.5), 0.5)
})
