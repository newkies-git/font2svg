import assert from 'node:assert/strict'
import test from 'node:test'
import { CANVAS, IMAGE_FIT_MARGIN, IMAGE_MAX_COMPONENTS } from '../shared/constants.ts'
import { binarize, grayscaleOf, otsuThreshold, shouldInvert, traceImageMask } from '../shared/imageTrace.ts'
import { pathBBox } from '../shared/paths.ts'

const SIZE = 200
const BAR_WIDTH = 120

function maskWith(draw: (x: number, y: number) => boolean): Uint8Array {
  const mask = new Uint8Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) mask[y * SIZE + x] = draw(x, y) ? 1 : 0
  return mask
}

const inBox = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1
const boundsOf = (path: string) => pathBBox(path)!

test('흑백 변환: 투명한 픽셀은 흰색으로, 불투명한 픽셀은 휘도로 바뀐다', () => {
  const rgba = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 0, 255, 0, 0, 255])
  const gray = grayscaleOf(rgba, 4)
  assert.equal(gray[0], 0)
  assert.equal(gray[1], 255)
  assert.equal(gray[2], 255, '완전히 투명하면 배경(흰색)')
  assert.equal(gray[3], Math.round(255 * 0.299), '빨강의 휘도')
})

test('Otsu 경계는 어두운 값 묶음과 밝은 값 묶음 사이에 놓인다', () => {
  const gray = new Uint8Array(100)
  gray.fill(30, 0, 30)
  gray.fill(220, 30)
  const threshold = otsuThreshold(gray)
  assert.ok(threshold >= 30 && threshold < 220, `threshold=${threshold}`)
  const mask = binarize(gray, threshold, false)
  assert.equal(mask.reduce((a, b) => a + b, 0), 30, '어두운 30칸이 잉크')
  assert.equal(binarize(gray, threshold, true).reduce((a, b) => a + b, 0), 70, '반전하면 밝은 칸이 잉크')
})

test('어두운 쪽이 절반을 넘으면 반전이 필요하다', () => {
  assert.equal(shouldInvert(new Uint8Array([10, 10, 10, 200]), 100), true)
  assert.equal(shouldInvert(new Uint8Array([10, 200, 200, 200]), 100), false)
})

test('가로 막대 하나: 윤곽 하나가 여백을 두고 저장 좌표계 가운데에 놓인다', () => {
  const { contours, components } = traceImageMask(maskWith((x, y) => inBox(x, y, 40, 90, 40 + BAR_WIDTH, 110)), SIZE, SIZE)
  assert.equal(components, 1)
  const box = boundsOf(contours[0])
  // 긴 변(가로)이 CANVAS - 2 × 여백을 채운다. 윤곽 추적은 픽셀 중심을 따라가므로 한 픽셀 반 안쪽의 오차는 허용한다.
  const tolerance = ((CANVAS - 2 * IMAGE_FIT_MARGIN) / BAR_WIDTH) * 1.5
  assert.ok(Math.abs(box.minX - IMAGE_FIT_MARGIN) <= tolerance, `minX=${box.minX}`)
  assert.ok(Math.abs(box.maxX - (CANVAS - IMAGE_FIT_MARGIN)) <= tolerance, `maxX=${box.maxX}`)
  // 세로는 가운데에 놓인다.
  assert.ok(Math.abs((box.minY + box.maxY) / 2 - CANVAS / 2) <= tolerance)
  assert.ok(box.maxY - box.minY < box.maxX - box.minX)
})

test('이미지의 위쪽은 저장 좌표계에서 y가 큰 쪽이다(y축 위쪽)', () => {
  const upper = traceImageMask(maskWith((x, y) => inBox(x, y, 90, 20, 110, 100) || inBox(x, y, 90, 140, 110, 180)), SIZE, SIZE)
  assert.equal(upper.components, 2)
  const [top, bottom] = upper.contours.map(boundsOf)
  assert.ok(top.minY > bottom.maxY, '읽는 순서(위→아래)로 돌려주고 위쪽 덩어리의 y가 더 크다')
})

test('고리 모양은 안쪽 구멍을 윤곽에 포함한다', () => {
  const { contours } = traceImageMask(maskWith((x, y) => inBox(x, y, 50, 50, 150, 150) && !inBox(x, y, 80, 80, 120, 120)), SIZE, SIZE)
  assert.equal(contours.length, 1)
  assert.equal((contours[0].match(/M/g) ?? []).length, 2, '바깥 윤곽과 구멍 윤곽')
})

test('작은 잡음 덩어리는 버린다', () => {
  const noisy = maskWith((x, y) => inBox(x, y, 40, 90, 160, 110) || inBox(x, y, 10, 10, 12, 12))
  assert.equal(traceImageMask(noisy, SIZE, SIZE).components, 1)
})

test('잉크가 없으면 던진다', () => {
  assert.throws(() => traceImageMask(new Uint8Array(SIZE * SIZE), SIZE, SIZE), /글자를 찾지 못했습니다/)
})

test('덩어리가 너무 많으면 던진다', () => {
  const count = IMAGE_MAX_COMPONENTS + 1
  const dots = maskWith((x, y) => x % 6 < 3 && y % 6 < 3 && x < count * 6 && y < 3)
  assert.throws(() => traceImageMask(dots, SIZE, SIZE), /너무 많습니다/)
})
