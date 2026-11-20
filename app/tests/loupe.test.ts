import assert from 'node:assert/strict'
import test from 'node:test'
import { CANVAS } from '../shared/constants.ts'
import { LOUPE_RADIUS, nextLoupeZoom, placeLoupe } from '../src/composables/useCanvasLoupe.ts'

function coversCursor(lens: { cx: number; cy: number }, x: number, y: number): boolean {
  return Math.hypot(lens.cx - x, lens.cy - y) < LOUPE_RADIUS
}

test('돋보기는 캔버스 안에 있고 커서를 덮지 않는다', () => {
  const points: Array<[number, number]> = [
    [CANVAS / 2, CANVAS / 2],
    [12, 12],
    [CANVAS - 12, 12],
    [12, CANVAS - 12],
    [CANVAS - 12, CANVAS - 12],
    [CANVAS / 2, 8],
    [8, CANVAS / 2],
    [CANVAS - 8, CANVAS / 2],
    [CANVAS / 2, CANVAS - 8],
  ]
  for (const [x, y] of points) {
    const lens = placeLoupe(x, y)
    assert.ok(lens.cx - LOUPE_RADIUS >= 0 && lens.cx + LOUPE_RADIUS <= CANVAS, `가로 ${x},${y}`)
    assert.ok(lens.cy - LOUPE_RADIUS >= 0 && lens.cy + LOUPE_RADIUS <= CANVAS, `세로 ${x},${y}`)
    assert.equal(coversCursor(lens, x, y), false, `${x},${y} → ${lens.cx},${lens.cy}`)
  }
})

test('가운데에서는 커서의 오른쪽 위에 둔다', () => {
  const lens = placeLoupe(CANVAS / 2, CANVAS / 2)
  assert.ok(lens.cx > CANVAS / 2)
  assert.ok(lens.cy < CANVAS / 2)
})

test('휠은 배율을 2와 8 사이에서 0.5씩 바꾼다', () => {
  assert.equal(nextLoupeZoom(4, -1), 4.5)
  assert.equal(nextLoupeZoom(4, 1), 3.5)
  assert.equal(nextLoupeZoom(8, -1), 8)
  assert.equal(nextLoupeZoom(2, 1), 2)
})
