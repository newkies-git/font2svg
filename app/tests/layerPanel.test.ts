import assert from 'node:assert/strict'
import test from 'node:test'
import { LAYER_ID } from '../shared/constants.ts'
import type { LayerRecord } from '../shared/types.ts'
import { canApplyToStrokes, canFetch, canReset, isSoloedLayer, layerCountText, thumbPaths } from '../src/lib/layerPanel.ts'
import { strokeOf } from './helpers.ts'

const layer = (overrides: Partial<LayerRecord>): LayerRecord => ({
  id: 'x', kind: 'CUSTOM', name: 'x', z_index: 0, visible: true, opacity: 1, locked: false, label_color: 'ink',
  available: true, modified: false, source_url: null, strokes: [], paths: [], ...overrides,
})
const oneStroke = strokeOf('M0 0 L10 0 L10 10 Z', [[0, 0], [10, 10]])

test('단독 보기는 이 레이어만 보일 때 참이다', () => {
  const layers = [layer({ id: 'a' }), layer({ id: 'b', visible: false })]
  assert.equal(isSoloedLayer(layers, 'a'), true)
  assert.equal(isSoloedLayer(layers, 'b'), false, '숨겨진 레이어는 단독이 아니다')
  assert.equal(isSoloedLayer([...layers, layer({ id: 'c' })], 'a'), false)
  assert.equal(isSoloedLayer(layers, 'none'), false)
})

test('수신은 아직 받지 않은 레퍼런스 레이어에서만 가능하다', () => {
  assert.equal(canFetch(layer({ kind: 'NAVER', available: false })), true)
  assert.equal(canFetch(layer({ kind: 'NAVER', available: true })), false)
  assert.equal(canFetch(layer({ kind: 'CUSTOM', available: false })), false)
})

test('작업 획으로 복사하려면 작업 획 레이어가 아니고 획이 있어야 한다', () => {
  assert.equal(canApplyToStrokes(null), false)
  assert.equal(canApplyToStrokes(layer({ id: LAYER_ID.strokes, strokes: [oneStroke] })), false)
  assert.equal(canApplyToStrokes(layer({ strokes: [] })), false)
  assert.equal(canApplyToStrokes(layer({ strokes: [oneStroke] })), true)
})

test('원본 복원은 원본이 있는 종류가 수정됐거나 저장 전 변경이 있을 때만 가능하다', () => {
  assert.equal(canReset(null, new Set()), false)
  assert.equal(canReset(layer({ kind: 'CUSTOM', modified: true }), new Set()), false)
  assert.equal(canReset(layer({ kind: 'FONT' }), new Set()), false)
  assert.equal(canReset(layer({ kind: 'FONT', modified: true }), new Set()), true)
  assert.equal(canReset(layer({ id: 'o', kind: 'OUTLINE' }), new Set(['o'])), true)
  assert.equal(canReset(layer({ kind: 'MMH', modified: true }), new Set()), true)
})

test('개수 문구는 획·윤곽·미수신 순으로 정한다', () => {
  assert.equal(layerCountText(layer({ kind: 'MEDIANS' })), '')
  assert.equal(layerCountText(layer({ strokes: [oneStroke, oneStroke] })), '2획')
  assert.equal(layerCountText(layer({ paths: ['M0 0'] })), '윤곽 1')
  assert.equal(layerCountText(layer({ kind: 'OUTLINE' })), '미생성')
  assert.equal(layerCountText(layer({ kind: 'NAVER' })), '미수신')
})

test('썸네일은 획 윤곽을 우선하고 빈 윤곽은 뺀다', () => {
  assert.deepEqual(thumbPaths(layer({ strokes: [oneStroke, { ...oneStroke, outline_path: '' }], paths: ['P'] })), [oneStroke.outline_path])
  assert.deepEqual(thumbPaths(layer({ paths: ['P'] })), ['P'])
})
