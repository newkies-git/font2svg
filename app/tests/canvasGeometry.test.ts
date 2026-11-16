import assert from 'node:assert/strict'
import test from 'node:test'
import { bezierNodesOf, connectLabel, medianLength, polylinePoints, strokeDash } from '../src/lib/canvasGeometry.ts'
import { rectPath, strokeOf } from './helpers.ts'

test('bezierNodesOf: 직선 윤곽은 앵커만, 경로가 없으면 빈 결과', () => {
  const { anchors, controls, lines } = bezierNodesOf(rectPath(0, 0, 10, 10))
  assert.equal(anchors.length, 4)
  assert.equal(controls.length, 0)
  assert.equal(lines.length, 0)
  assert.deepEqual(bezierNodesOf(null), { anchors: [], controls: [], lines: [] })
})

test('bezierNodesOf: Q는 제어점 1개·제어선 2개, C는 제어점 2개·제어선 2개', () => {
  const q = bezierNodesOf('M 0 0 Q 5 10 10 0 Z')
  assert.equal(q.anchors.length, 2)
  assert.deepEqual(q.controls, [{ kind: 'c1', segIndex: 1, x: 5, y: 10 }])
  assert.deepEqual(q.lines, [{ x1: 0, y1: 0, x2: 5, y2: 10 }, { x1: 10, y1: 0, x2: 5, y2: 10 }])
  const c = bezierNodesOf('M 0 0 C 2 8 8 8 10 0 Z')
  assert.deepEqual(c.controls.map((p) => p.kind), ['c1', 'c2'])
  assert.deepEqual(c.lines, [{ x1: 0, y1: 0, x2: 2, y2: 8 }, { x1: 10, y1: 0, x2: 8, y2: 8 }])
})

test('bezierNodesOf: Z 뒤의 새 곡선은 시작점에서 이어진다', () => {
  const nodes = bezierNodesOf('M 0 0 L 10 0 Z Q 5 5 8 8')
  assert.deepEqual(nodes.lines[0], { x1: 0, y1: 0, x2: 5, y2: 5 })
})

test('medianLength·strokeDash: 쓴 획은 0, 쓰는 중은 비율, 아직은 전체', () => {
  assert.equal(medianLength([[0, 0], [3, 4], [3, 10]]), 11)
  assert.equal(medianLength([[1, 1]]), 0)
  const stroke = strokeOf(rectPath(0, 0, 1, 1), [[0, 0], [10, 0]], { stroke_width: 20 })
  assert.deepEqual(strokeDash(stroke, 0, 3, 0.5), { array: 30, offset: 0 })
  assert.deepEqual(strokeDash(stroke, 2, 3, 0.5), { array: 30, offset: 15 })
  assert.deepEqual(strokeDash(stroke, 3, 3, 0.5), { array: 30, offset: 30 })
})

test('polylinePoints·connectLabel', () => {
  assert.equal(polylinePoints([[1, 2], [3, 4]]), '1,2 3,4')
  assert.deepEqual([0, 1, 2, 3].map((i) => connectLabel(i, 4)), ['시', '1', '2', '끝'])
  assert.equal(connectLabel(0, 1), '시')
})
