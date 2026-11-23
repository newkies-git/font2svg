import assert from 'node:assert/strict'
import test from 'node:test'
import { commandCounts, hasSliver, measureExtraction, measureOutline, summarizeExtraction } from '../server/extractMetrics.ts'
import { medianTurns, turnAngleDeg } from '../shared/medianShape.ts'
import { rectPath } from './helpers.ts'

test('명령 수와 곡선 비율: L은 직선, C·Q는 곡선으로 센다', () => {
  assert.deepEqual(commandCounts('M 0 0 L 1 0 L 1 1 Q 0 1 0 0 Z'), { lines: 2, curves: 1 })
  assert.deepEqual(measureOutline('M 0 0 L 1 0 L 1 1 L 0 1 Z'), { vertices: 3, curveRatio: 0 })
  assert.equal(measureOutline('M 0 0 Z').curveRatio, 0)
})

test('꺾임 각도: 직진 0°, 직각 90°, 되돌림 180°', () => {
  assert.equal(turnAngleDeg([0, 0], [1, 0], [2, 0]), 0)
  assert.equal(Math.round(turnAngleDeg([0, 0], [1, 0], [1, 1])), 90)
  assert.equal(Math.round(turnAngleDeg([0, 0], [1, 0], [0, 0.0001])), 180)
  assert.equal(turnAngleDeg([0, 0], [0, 0], [1, 1]), 0)
})

test('중심선 꺾임·되돌림: 60° 초과는 꺾임, 100° 초과는 되돌림', () => {
  assert.deepEqual(medianTurns([[0, 0], [10, 0], [20, 0]]), { kink: false, reversal: false })
  assert.deepEqual(medianTurns([[0, 0], [10, 0], [10, 10]]), { kink: true, reversal: false })
  assert.deepEqual(medianTurns([[0, 0], [10, 0], [0, 1]]), { kink: true, reversal: true })
})

test('파편: 서브패스가 둘 이상이고 아주 작은 것이 있으면 참', () => {
  assert.equal(hasSliver(rectPath(0, 0, 100, 100)), false)
  assert.equal(hasSliver(`${rectPath(0, 0, 100, 100)} ${rectPath(200, 0, 202, 2)}`), true)
  assert.equal(hasSliver(`${rectPath(0, 0, 100, 100)} ${rectPath(200, 0, 300, 100)}`), false)
})

test('추출 측정: 나눌 수 없으면 fitted=false, 요약은 비율과 중앙값을 모은다', () => {
  assert.deepEqual(measureExtraction('空', [], []), { char: '空', strokes: [], fitted: false })
  const stroke = { vertices: 10, curveRatio: 0.5, medianPoints: 3, kink: true, reversal: false, sliver: false, ribbon: true, unmatchedUsable: false }
  const summary = summarizeExtraction(
    [{ char: '一', fitted: true, strokes: [stroke, { ...stroke, kink: false, ribbon: false }] }, { char: '二', fitted: false, strokes: [] }],
    { vertices: [8, 12, 10], curveRatios: [1, 1, 1], medians: [[[0, 0], [10, 0], [10, 10]], [[0, 0], [10, 0]]] },
  )
  assert.deepEqual(summary.chars, { sampled: 2, fitted: 1, rejected: 1 })
  assert.equal(summary.strokes, 2)
  assert.deepEqual(summary.median.kink, { count: 1, total: 2, percent: 50 })
  assert.deepEqual(summary.ribbon, { count: 1, total: 2, percent: 50 })
  assert.deepEqual(summary.charsWithRibbon, { count: 1, total: 1, percent: 100 })
  assert.equal(summary.reference.medianVertices, 10)
  assert.equal(summary.reference.meanCurveRatio, 1)
  assert.deepEqual(summary.reference.kink, { count: 1, total: 2, percent: 50 })
})

test('추출 측정: 빈 입력도 0으로 요약한다', () => {
  const summary = summarizeExtraction([], { vertices: [], curveRatios: [], medians: [] })
  assert.equal(summary.strokes, 0)
  assert.equal(summary.outline.medianVertices, 0)
  assert.equal(summary.ribbon.percent, 0)
})
