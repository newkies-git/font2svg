import assert from 'node:assert/strict'
import test from 'node:test'
import { polygonArea } from '../shared/paths.ts'
import { pathArea, pathBounds, pathCovers } from './helpers.ts'

test('polygonArea: 감는 방향에 따라 부호가 다르고 크기는 같다', () => {
  const clockwise = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 0 }]
  assert.equal(polygonArea(clockwise), -200)
  assert.equal(polygonArea(clockwise.slice().reverse()), 200)
  assert.equal(polygonArea([{ x: 0, y: 0 }, { x: 1, y: 1 }]), 0, '점이 둘이면 면적이 없다')
  assert.equal(polygonArea([]), 0)
})

test('경로 기하 도우미: 구멍은 면적에서 빼고, 점 포함은 구멍 안을 덮지 않는 것으로 본다', () => {
  // 바깥 100×100, 안쪽 구멍 40×40(반대로 감김)
  const ring = 'M0 0 L100 0 L100 100 L0 100 Z M30 30 L30 70 L70 70 L70 30 Z'
  assert.equal(pathArea(ring), 100 * 100 - 40 * 40)
  assert.deepEqual(pathBounds(ring), { minX: 0, maxX: 100, minY: 0, maxY: 100 })
  assert.equal(pathCovers(ring, { x: 10, y: 10 }), true)
  assert.equal(pathCovers(ring, { x: 50, y: 50 }), false, '구멍 안')
  assert.equal(pathCovers(ring, { x: 150, y: 50 }), false, '바깥')
})
