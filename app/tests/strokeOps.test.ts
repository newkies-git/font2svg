import assert from 'node:assert/strict'
import test from 'node:test'
import { boxAlignTransform, moveItem, pointsToClosedPath, restrokeFromOutline, roundPt, withMedianPoints } from '../src/lib/strokeOps.ts'
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
