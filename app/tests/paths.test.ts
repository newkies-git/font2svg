import assert from 'node:assert/strict'
import test from 'node:test'
import { flattenContours, parseCommands, pointSegmentDistance, polygonArea } from '../shared/paths.ts'
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

// 곡선을 편 꼭짓점들이 실제 곡선에서 얼마나 벗어나는지: 곡선을 촘촘히 찍어 가장 가까운 선분까지의 최대 거리
function maxDeviation(curve: (t: number) => { x: number; y: number }, polyline: { x: number; y: number }[]): number {
  const SAMPLES = 2000
  let worst = 0
  for (let i = 0; i <= SAMPLES; i++) {
    const point = curve(i / SAMPLES)
    let nearest = Infinity
    for (let k = 0; k + 1 < polyline.length; k++) nearest = Math.min(nearest, pointSegmentDistance(point, polyline[k], polyline[k + 1]))
    worst = Math.max(worst, nearest)
  }
  return worst
}

const quadratic = (t: number) => ({ x: 2 * (1 - t) * t * 500 + t * t * 1000, y: 2 * (1 - t) * t * 800 })
const cubic = (t: number) => ({
  x: 3 * (1 - t) * t * t * 1000 + t ** 3 * 1000,
  y: 3 * (1 - t) ** 2 * t * 600 + 3 * (1 - t) * t * t * 600,
})
const FLATNESS_LEVELS = [0.5, 1, 2, 5]
// 깊이 상한(8)에 닿으면 구간이 2^9개까지 나뉜다. 시작·닫는 점과 합쳐 이만큼을 넘지 않는다.
const MAX_FLATTENED_POINTS = 2 ** 9 + 2

test('flattenContours: 2차 곡선을 허용 오차 안으로 펴고 끝점을 지킨다', () => {
  for (const flatness of FLATNESS_LEVELS) {
    const [contour] = flattenContours('M0 0 Q500 800 1000 0 Z', flatness)
    assert.deepEqual(contour[0], { x: 0, y: 0 })
    assert.deepEqual(contour[contour.length - 2], { x: 1000, y: 0 }, '곡선 끝점')
    assert.ok(maxDeviation(quadratic, contour.slice(0, -1)) <= flatness, `flatness ${flatness}`)
  }
})

test('flattenContours: 3차 곡선을 허용 오차 안으로 펴고 끝점을 지킨다', () => {
  for (const flatness of FLATNESS_LEVELS) {
    const [contour] = flattenContours('M0 0 C0 600 1000 600 1000 0 Z', flatness)
    assert.deepEqual(contour[0], { x: 0, y: 0 })
    assert.deepEqual(contour[contour.length - 2], { x: 1000, y: 0 }, '곡선 끝점')
    assert.ok(maxDeviation(cubic, contour.slice(0, -1)) <= flatness, `flatness ${flatness}`)
  }
})

test('flattenContours: 허용 오차가 작을수록 꼭짓점이 늘고, 직선 모양의 곡선은 끝점만 남는다', () => {
  const coarse = flattenContours('M0 0 Q500 800 1000 0 Z', 5)[0].length
  const fine = flattenContours('M0 0 Q500 800 1000 0 Z', 0.5)[0].length
  assert.ok(fine > coarse)
  assert.equal(flattenContours('M0 0 C100 0 200 0 300 0 L300 100 Z', 1)[0].length, 4, '시작, 곡선 끝, 선 끝, 닫는 점')
  assert.equal(flattenContours('M0 0 Q150 0 300 0 L300 100 Z', 1)[0].length, 4)
})

test('flattenContours: 허용 오차가 아주 작아도 재귀가 깊이 상한에서 멈춘다(2차·3차)', () => {
  const tiny = 0.0001
  assert.ok(flattenContours('M0 0 Q500000 800000 1000000 0 Z', tiny)[0].length <= MAX_FLATTENED_POINTS)
  assert.ok(flattenContours('M0 0 C0 600000 1000000 600000 1000000 0 Z', tiny)[0].length <= MAX_FLATTENED_POINTS)
})

test('flattenContours: 같은 점이 이어지면 한 번만 담는다', () => {
  assert.deepEqual(flattenContours('M0 0 L10 0 L10 0 L10 10 Z', 1)[0], [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 }])
})

test('parseCommands: 상대 명령은 묶음 시작의 현재 점을 기준으로 절대 좌표가 된다', () => {
  assert.deepEqual(parseCommands('m10 20 l5 5 5 5 z m3 3 l1 1'), [
    { op: 'M', n: [10, 20] }, { op: 'L', n: [15, 25] }, { op: 'L', n: [20, 30] }, { op: 'Z', n: [] },
    { op: 'M', n: [13, 23] }, { op: 'L', n: [14, 24] },
  ])
  // Z 뒤의 현재 점은 서브패스 시작점이다
  assert.deepEqual(parseCommands('M10 10 L20 10 z l5 5').slice(-1), [{ op: 'L', n: [15, 15] }])
  assert.deepEqual(parseCommands('M0 0 Q10 20 30 0 q5 5 10 0'), [
    { op: 'M', n: [0, 0] }, { op: 'Q', n: [10, 20, 30, 0] }, { op: 'Q', n: [35, 5, 40, 0] },
  ])
  assert.deepEqual(parseCommands('M0 0 C1 2 3 4 5 6 c1 1 2 2 3 3').slice(-1), [{ op: 'C', n: [6, 7, 7, 8, 8, 9] }])
})

test('parseCommands: H·V는 한 좌표만 바꾸고, M 뒤 좌표 쌍은 선이 되며, 모자란 끝 숫자는 버린다', () => {
  assert.deepEqual(parseCommands('M0 0 H10 V20 h-5 v-5'), [
    { op: 'M', n: [0, 0] }, { op: 'L', n: [10, 0] }, { op: 'L', n: [10, 20] }, { op: 'L', n: [5, 20] }, { op: 'L', n: [5, 15] },
  ])
  assert.deepEqual(parseCommands('M0 0 10 10 20 0'), [{ op: 'M', n: [0, 0] }, { op: 'L', n: [10, 10] }, { op: 'L', n: [20, 0] }])
  assert.deepEqual(parseCommands('M0 0 L1'), [{ op: 'M', n: [0, 0] }])
  assert.deepEqual(parseCommands('M0 0 Q1 2 3'), [{ op: 'M', n: [0, 0] }])
  assert.deepEqual(parseCommands('M1,2L3,4 5,6Z'), [{ op: 'M', n: [1, 2] }, { op: 'L', n: [3, 4] }, { op: 'L', n: [5, 6] }, { op: 'Z', n: [] }])
})

test('점-선분 거리: 선분 안쪽 수선, 양 끝 밖, 길이 0인 선분', () => {
  const a = { x: 0, y: 0 }
  const b = { x: 10, y: 0 }
  assert.equal(pointSegmentDistance({ x: 5, y: 3 }, a, b), 3, '수선의 발이 선분 안')
  assert.equal(pointSegmentDistance({ x: -4, y: 3 }, a, b), 5, '시작점 바깥은 시작점까지')
  assert.equal(pointSegmentDistance({ x: 13, y: 4 }, a, b), 5, '끝점 바깥은 끝점까지')
  assert.equal(pointSegmentDistance({ x: 3, y: 4 }, a, a), 5, '선분이 한 점이면 그 점까지')
})
