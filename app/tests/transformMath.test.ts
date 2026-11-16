import assert from 'node:assert/strict'
import test from 'node:test'
import { distortMap, handleDirsFor, handlePoint, rotateMap, skewMap } from '../src/lib/transformMath.ts'

const box = { minX: 0, minY: 0, maxX: 100, maxY: 200 }
const near = (actual: number[], expected: number[]) => actual.every((v, i) => Math.abs(v - expected[i]) < 1e-6)

test('회전: 중심 기준 90도', () => {
  const rotate = rotateMap([50, 100], [100, 100], [50, 150], false)
  assert.ok(near(rotate(100, 100), [50, 150]))
  assert.ok(near(rotate(50, 100), [50, 100]))
})

test('회전: Shift는 15도 단위로 맞춘다', () => {
  const rotate = rotateMap([0, 0], [10, 0], [10 * Math.cos(0.35), 10 * Math.sin(0.35)], true)
  assert.ok(near(rotate(10, 0), [10 * Math.cos(Math.PI / 12), 10 * Math.sin(Math.PI / 12)]))
})

test('기울임: 반대편 변을 고정하고 핸들 변을 민다', () => {
  const north = skewMap(box, 'n', [50, 200], [70, 200])
  assert.ok(near(north(0, 200), [20, 200]))
  assert.ok(near(north(0, 0), [0, 0]))
  assert.ok(near(north(0, 100), [10, 100]))
  const east = skewMap(box, 'e', [100, 100], [100, 130])
  assert.ok(near(east(100, 0), [100, 30]))
  assert.ok(near(east(0, 0), [0, 0]))
})

test('왜곡: 모서리 하나만 움직이고 나머지는 고정', () => {
  const { map, areaRatio } = distortMap(box, 'ne', [100, 200], [130, 210])
  assert.ok(near(map(0, 0), [0, 0]))
  assert.ok(near(map(100, 0), [100, 0]))
  assert.ok(near(map(0, 200), [0, 200]))
  assert.ok(near(map(100, 200), [130, 210]))
  assert.ok(near(map(50, 100), [(0 + 100 + 0 + 130) / 4, (0 + 0 + 200 + 210) / 4]))
  assert.ok(areaRatio > 1)
})

test('핸들 위치와 방식별 핸들 구성', () => {
  assert.ok(near(handlePoint(box, 'nw'), [0, 200]))
  assert.ok(near(handlePoint(box, 's'), [50, 0]))
  assert.equal(handleDirsFor('scale').length, 8)
  assert.equal(handleDirsFor('rotate').length, 4)
  assert.equal(handleDirsFor('skew').length, 4)
  assert.equal(handleDirsFor('distort').length, 4)
})
