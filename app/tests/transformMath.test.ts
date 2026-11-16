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

test('드래그 변환(크기): 반대편 모서리를 고정하고 비율만큼 늘인다', async () => {
  const { dragTransform } = await import('../src/lib/transformMath.ts')
  const box = { minX: 0, minY: 0, maxX: 100, maxY: 100 }
  const east = dragTransform('scale', box, 'e', [100, 50], [200, 50], false)
  assert.deepEqual(east.fn(100, 50), [200, 50])
  assert.deepEqual(east.fn(0, 50), [0, 50], '왼쪽 변이 고정')
  assert.equal(east.scaleFactor, 1.5, '가로만 2배면 평균 배율 1.5')
  const northWest = dragTransform('scale', box, 'nw', [0, 100], [-100, 100], false)
  assert.deepEqual(northWest.fn(100, 0), [100, 0], '반대편(오른쪽 아래) 모서리가 고정')
  assert.deepEqual(northWest.fn(0, 0), [-100, 0], '가로 2배: 왼쪽 끝이 고정점에서 200만큼 멀어진다')
})

test('드래그 변환(크기): Shift는 같은 비율, 너무 줄이면 최소 배율에서 멈춘다', async () => {
  const { dragTransform } = await import('../src/lib/transformMath.ts')
  const box = { minX: 0, minY: 0, maxX: 100, maxY: 100 }
  const corner = dragTransform('scale', box, 'ne', [100, 100], [300, 150], true)
  assert.deepEqual(corner.fn(100, 100), [225, 225], '가로 3배·세로 1.5배의 평균(2.25배)을 양쪽에 똑같이 쓴다')
  const edge = dragTransform('scale', box, 'e', [100, 50], [300, 50], true)
  assert.deepEqual(edge.fn(100, 100), [300, 200], '가로 변 핸들도 Shift면 세로에 같은 3배(중심 y=50 기준)')
  const plain = dragTransform('scale', box, 'e', [100, 50], [300, 50], false)
  assert.deepEqual(plain.fn(100, 100), [300, 100], 'Shift가 없으면 가로만')
  const squeezed = dragTransform('scale', box, 'e', [100, 50], [-500, 50], false)
  assert.equal(squeezed.fn(100, 0)[0], 10, '최소 배율 0.1')
})

test('드래그 변환: 회전·기울임·왜곡은 해당 변환 함수를 돌려주고 배율은 1(왜곡은 넓이 기준)', async () => {
  const { dragTransform, rotateMap, skewMap } = await import('../src/lib/transformMath.ts')
  const box = { minX: 0, minY: 0, maxX: 100, maxY: 100 }
  const rotated = dragTransform('rotate', box, 'ne', [100, 50], [50, 100], false)
  const expected = rotateMap([50, 50], [100, 50], [50, 100], false)
  assert.deepEqual(rotated.fn(10, 20), expected(10, 20))
  assert.equal(rotated.scaleFactor, 1)
  const skewed = dragTransform('skew', box, 'n', [50, 100], [80, 100], false)
  assert.deepEqual(skewed.fn(10, 50), skewMap(box, 'n', [50, 100], [80, 100])(10, 50))
  assert.equal(skewed.scaleFactor, 1)
  const distorted = dragTransform('distort', box, 'ne', [100, 100], [200, 200], false)
  assert.ok(distorted.scaleFactor > 1)
})
