import assert from 'node:assert/strict'
import test from 'node:test'
import { CANVAS } from '../shared/constants.ts'
import { FULL_CANVAS_VIEW, isFullView, panView, viewFromSelection, zoomViewAt } from '../src/lib/canvasView.ts'

test('작은 클릭은 확대하지 않고, 드래그한 영역은 그 자리가 된다', () => {
  assert.equal(viewFromSelection(10, 10, 12, 11), null)
  const view = viewFromSelection(400, 200, 520, 360)
  assert.deepEqual(view, { x: 400, y: 200, w: 120, h: 160 })
})

test('너무 좁은 영역은 최소 크기까지 벌린다', () => {
  const view = viewFromSelection(100, 100, 110, 180)
  assert.ok(view)
  assert.equal(view.w, 32)
  assert.equal(view.h, 80)
  assert.ok(view.x < 100)
})

test('휠은 커서 위치를 유지한 채 확대하고, 전체보다 작아지지 않는다', () => {
  const zoomed = zoomViewAt(FULL_CANVAS_VIEW, CANVAS / 2, CANVAS / 2, true)
  assert.ok(zoomed.w < CANVAS)
  assert.ok(zoomed.h < CANVAS)
  const relX = (CANVAS / 2 - zoomed.x) / zoomed.w
  const relY = (CANVAS / 2 - zoomed.y) / zoomed.h
  assert.ok(Math.abs(relX - 0.5) < 1e-9)
  assert.ok(Math.abs(relY - 0.5) < 1e-9)
  assert.ok(isFullView(zoomViewAt(FULL_CANVAS_VIEW, 10, 10, false)))
})

test('화면 이동은 가로세로 크기만 두고 원점만 옮긴다', () => {
  const view = { x: 100, y: 80, w: 200, h: 200 }
  assert.deepEqual(panView(view, 15, -4), { x: 85, y: 84, w: 200, h: 200 })
})
