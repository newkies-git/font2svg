import assert from 'node:assert/strict'
import test from 'node:test'
import { flattenContours, polygonArea } from '../shared/paths.ts'
import { mergeNearLoops } from '../shared/strokeCut/merge.ts'
import { rectPath } from './helpers.ts'

const GAP = 30
const LEFT = rectPath(0, 0, 200, 100)
const NEAR = rectPath(210, 0, 400, 100)
const FAR = rectPath(400, 0, 600, 100)
const OVERLAPPING = rectPath(150, 0, 350, 100)
const HOLE = 'M 50 30 L 50 70 L 150 70 L 150 30 Z'

const areaOf = (path: string): number => flattenContours(path, 1).reduce((sum, loop) => sum + Math.abs(polygonArea(loop)), 0)

test('조각 잇기: 빈틈이 gap 이내로 마주 보는 두 조각은 빈틈까지 메워 한 서브패스가 된다', () => {
  const merged = mergeNearLoops([LEFT, NEAR], GAP)
  assert.equal(merged.length, 1)
  const loops = flattenContours(merged[0], 1)
  assert.equal(loops.length, 1)
  // 두 조각 면적(20000 + 19000)에 사이 빈틈(10×100)이 더해진 크기다.
  assert.ok(areaOf(merged[0]) > areaOf(LEFT) + areaOf(NEAR) + 500, `${areaOf(merged[0])}`)
})

test('조각 잇기: gap보다 먼 조각은 그대로 둔다', () => {
  assert.deepEqual(mergeNearLoops([LEFT, FAR], GAP), [LEFT, FAR])
})

test('조각 잇기: 서로 겹친 조각은 그대로 둔다(채움이 이미 합쳐 보인다)', () => {
  assert.deepEqual(mergeNearLoops([LEFT, OVERLAPPING], GAP), [LEFT, OVERLAPPING])
})

test('조각 잇기: 반대 방향 서브패스(구멍)는 잇지 않는다', () => {
  assert.deepEqual(mergeNearLoops([LEFT, HOLE], GAP), [LEFT, HOLE])
})

test('조각 잇기: 서브패스가 하나면 그대로 둔다', () => {
  assert.deepEqual(mergeNearLoops([LEFT], GAP), [LEFT])
})
