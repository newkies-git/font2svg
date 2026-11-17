import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSegments, degrees, pruneSpurs } from '../shared/strokeCut/skeleton.ts'

const WIDTH = 40
const HEIGHT = 20
const index = (x: number, y: number) => y * WIDTH + x

// 지정한 좌표만 1인 골격
function skeletonOf(points: [number, number][]): Uint8Array {
  const skeleton = new Uint8Array(WIDTH * HEIGHT)
  for (const [x, y] of points) skeleton[index(x, y)] = 1
  return skeleton
}

const horizontal = (x0: number, x1: number, y: number): [number, number][] => Array.from({ length: x1 - x0 + 1 }, (_, i) => [x0 + i, y])
const vertical = (x: number, y0: number, y1: number): [number, number][] => Array.from({ length: y1 - y0 + 1 }, (_, i) => [x, y0 + i])
const count = (skeleton: Uint8Array) => skeleton.reduce((sum, value) => sum + value, 0)

// 가로 줄 가운데에 위로 솟은 가지. 가지의 끝은 끝점이고 뿌리는 갈림이다.
const SPUR_X = 20
const MAIN_Y = 16
const SHORT_SPUR_LENGTH = 4
// 이 길이 이상이면 가지로 보지 않는 기준(skeleton.ts의 SPUR_SCAN_LENGTH)과 같은 값
const LONG_SPUR_LENGTH = 14

test('짧은 가지는 줄기에 닿은 한 픽셀만 남기고 지운다', () => {
  const main = horizontal(5, 35, MAIN_Y)
  const skeleton = skeletonOf([...main, ...vertical(SPUR_X, MAIN_Y - SHORT_SPUR_LENGTH, MAIN_Y - 1)])
  pruneSpurs(skeleton, WIDTH, HEIGHT)
  assert.ok(main.every(([x, y]) => skeleton[index(x, y)] === 1), '줄기는 그대로다')
  assert.equal(count(skeleton), main.length + 1, '줄기에 닿은 갈림 픽셀 하나만 더 남는다')
  assert.equal(skeleton[index(SPUR_X, MAIN_Y - 1)], 1)
  assert.equal(skeleton[index(SPUR_X, MAIN_Y - 2)], 0)
})

test('충분히 긴 가지는 지우지 않는다', () => {
  const skeleton = skeletonOf([...horizontal(5, 35, MAIN_Y), ...vertical(SPUR_X, MAIN_Y - LONG_SPUR_LENGTH, MAIN_Y - 1)])
  const before = count(skeleton)
  pruneSpurs(skeleton, WIDTH, HEIGHT)
  assert.equal(count(skeleton), before)
})

test('갈림이 없는 한 줄 골격은 끝이 짧아도 지우지 않는다', () => {
  const skeleton = skeletonOf(horizontal(5, 12, MAIN_Y))
  pruneSpurs(skeleton, WIDTH, HEIGHT)
  assert.equal(count(skeleton), 8)
})

// 마름모 고리: 모든 픽셀의 이웃이 정확히 둘이라 끝점도 갈림도 없다.
const DIAMOND_CENTER = { x: 20, y: 10 }
const DIAMOND_RADIUS = 8

test('끝점과 갈림이 없는 닫힌 고리는 고리 전체를 한 구간으로 만든다', () => {
  const ring: [number, number][] = []
  for (let dx = -DIAMOND_RADIUS; dx <= DIAMOND_RADIUS; dx++) {
    const dy = DIAMOND_RADIUS - Math.abs(dx)
    ring.push([DIAMOND_CENTER.x + dx, DIAMOND_CENTER.y + dy])
    if (dy > 0) ring.push([DIAMOND_CENTER.x + dx, DIAMOND_CENTER.y - dy])
  }
  const skeleton = skeletonOf(ring)
  const deg = degrees(skeleton, WIDTH, HEIGHT)
  assert.ok(ring.every(([x, y]) => deg[index(x, y)] === 2), '모든 픽셀의 차수가 2다')
  const segments = buildSegments(skeleton, deg, WIDTH, HEIGHT)
  assert.equal(segments.length, 1)
  assert.equal(new Set(segments[0].chain).size, ring.length, '고리의 모든 픽셀을 한 번씩 지난다')
})
