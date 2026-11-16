import assert from 'node:assert/strict'
import test from 'node:test'
import { flattenContours } from '../shared/paths.ts'
import { applyCapShape, capLength, isCapShape, matchMedianEnd } from '../shared/strokeCut.ts'
import type { Pt } from '../shared/types.ts'
import { rectPath } from './helpers.ts'

// 가로 막대: x 100~600, y 460~540(폭 80), 중심선은 왼쪽에서 오른쪽
const BAR = { minX: 100, maxX: 600, minY: 460, maxY: 540 }
const WIDTH = BAR.maxY - BAR.minY
const BAR_PATH = rectPath(BAR.minX, BAR.minY, BAR.maxX, BAR.maxY)
const MEDIAN: Pt[] = [[BAR.minX + WIDTH / 2, 500], [BAR.maxX - WIDTH / 2, 500]]
// 래스터화 오차를 감안한 허용치
const TOLERANCE = 4
const AREA_TOLERANCE = 0.2
// 윤곽을 래스터로 다시 따면 한 번에 가장자리가 1칸쯤 줄어든다. 여러 번 거친 면적을 비교할 때의 허용 비율.
const RETRACE_TOLERANCE = 0.05

function areaOf(path: string): number {
  const points = flattenContours(path, 1.4)[0]
  let sum = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum / 2)
}

function boundsOf(path: string) {
  const points = flattenContours(path, 1.4)[0]
  const xs = points.map((point) => point.x)
  return { minX: Math.min(...xs), maxX: Math.max(...xs) }
}

const halfWidth = WIDTH / 2
// 모양을 붙이지 않고 같은 경로(래스터화 → 윤곽 추적)만 거친 면적: 깎인 정도를 재는 기준
const flatPath = applyCapShape(BAR_PATH, MEDIAN, 'start', null, WIDTH, true)
assert.ok(flatPath)
const barArea = areaOf(flatPath)

test('둥글게: 끝의 모서리만 깎이고 끝점 위치와 다른 쪽 끝은 그대로다', () => {
  const path = applyCapShape(BAR_PATH, MEDIAN, 'start', 'AUTO_ROUND', WIDTH, false)
  assert.ok(path)
  const bounds = boundsOf(path)
  assert.ok(Math.abs(bounds.minX - BAR.minX) <= TOLERANCE && Math.abs(bounds.maxX - BAR.maxX) <= TOLERANCE)
  const lost = 2 * halfWidth * capLength('AUTO_ROUND', WIDTH) * (1 - Math.PI / 4)
  assert.ok(Math.abs(barArea - areaOf(path) - lost) <= lost * AREA_TOLERANCE, `깎인 면적 ${barArea - areaOf(path)} (기대 ${lost})`)
})

test('끝(end)을 고르면 반대쪽 끝이 다듬어진다', () => {
  const start = applyCapShape(BAR_PATH, MEDIAN, 'start', 'POINTED', WIDTH, false)
  const end = applyCapShape(BAR_PATH, MEDIAN, 'end', 'POINTED', WIDTH, false)
  assert.ok(start && end)
  assert.ok(Math.abs(areaOf(start) - areaOf(end)) <= barArea * RETRACE_TOLERANCE, '대칭이라 깎인 면적이 같다')
  assert.notEqual(start, end)
})

test('뾰족하게는 둥글게보다 더 깎고, 눌러서(부풀림)는 폭보다 넓어진다', () => {
  const round = applyCapShape(BAR_PATH, MEDIAN, 'start', 'AUTO_ROUND', WIDTH, false)
  const pointed = applyCapShape(BAR_PATH, MEDIAN, 'start', 'POINTED', WIDTH, false)
  const bulge = applyCapShape(BAR_PATH, MEDIAN, 'start', 'BULGE', WIDTH, false)
  assert.ok(round && pointed && bulge)
  assert.ok(areaOf(pointed) < areaOf(round))
  const ys = flattenContours(bulge, 1.4)[0].map((point) => point.y)
  assert.ok(Math.max(...ys) - Math.min(...ys) > WIDTH + TOLERANCE, '부풀린 머리가 획 폭보다 넓다')
})

test('모양을 바꾸면 앞 모양이 남지 않고, 기본으로 돌아오면 원래 면적으로 복원된다', () => {
  const pointed = applyCapShape(BAR_PATH, MEDIAN, 'start', 'POINTED', WIDTH, false)
  assert.ok(pointed)
  const fresh = applyCapShape(BAR_PATH, MEDIAN, 'start', 'AUTO_ROUND', WIDTH, false)
  const switched = applyCapShape(pointed, MEDIAN, 'start', 'AUTO_ROUND', WIDTH, true)
  assert.ok(fresh && switched)
  assert.ok(Math.abs(areaOf(switched) - areaOf(fresh)) <= barArea * RETRACE_TOLERANCE, '뾰족 → 둥글게가 처음부터 둥글게와 같다')
  assert.ok(areaOf(switched) > areaOf(pointed) + (areaOf(fresh) - areaOf(pointed)) / 2, '뾰족하게 깎인 부분이 되살아난다')
  const restored = applyCapShape(switched, MEDIAN, 'start', null, WIDTH, true)
  assert.ok(restored)
  assert.ok(Math.abs(areaOf(restored) - barArea) <= barArea * RETRACE_TOLERANCE, '기본으로 복원')
})

test('적용할 수 없는 입력은 null: 중심선이 짧거나 윤곽이 비었거나 되돌릴 것도 모양도 없을 때', () => {
  assert.equal(applyCapShape(BAR_PATH, [MEDIAN[0]], 'start', 'AUTO_ROUND', WIDTH, false), null)
  assert.equal(applyCapShape('', MEDIAN, 'start', 'AUTO_ROUND', WIDTH, false), null)
  assert.equal(applyCapShape(BAR_PATH, MEDIAN, 'start', null, WIDTH, false), null)
})

test('모양 종류 판별: 도장·직접 그리기·기본은 윤곽을 바꾸는 모양이 아니다', () => {
  for (const type of ['AUTO_ROUND', 'POINTED', 'BULGE', 'TAPER'] as const) assert.equal(isCapShape(type), true)
  for (const type of ['NONE', 'REF_STAMP', 'MANUAL'] as const) assert.equal(isCapShape(type), false)
})

test('단면과 중심선 끝 짝짓기: 단면 가까이에서 단면 쪽을 향한 끝만 고른다', () => {
  const horizontal: Pt[] = [[100, 500], [500, 500]]
  const faceAt = (x: number, alongX: number) => ({ origin: { x, y: 500 }, along: { x: alongX, y: 0 }, width: WIDTH, depth: 300 })
  assert.equal(matchMedianEnd(horizontal, faceAt(110, -1)), 'start')
  assert.equal(matchMedianEnd(horizontal, faceAt(490, 1)), 'end')
  assert.equal(matchMedianEnd(horizontal, faceAt(110, 1)), null, '끝이 단면과 반대 방향을 향한다')
  assert.equal(matchMedianEnd(horizontal, faceAt(300, -1)), null, '단면이 두 끝에서 멀다')
  assert.equal(matchMedianEnd([[100, 500]], faceAt(110, -1)), null)
})
