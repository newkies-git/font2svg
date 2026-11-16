import assert from 'node:assert/strict'
import test from 'node:test'
import { fontContoursOf, fontFingerprint, sanitizeLayerPaths, sanitizeLayerStrokes } from '../server/layers.ts'
import type { LayerRecord } from '../src/types.ts'
import { rectPath, strokeOf } from './helpers.ts'

const valid = strokeOf(rectPath(0, 0, 100, 100), [[10, 10], [90, 90]])

test('획 검증: 번호를 다시 매기고 폭을 제한한다', () => {
  const result = sanitizeLayerStrokes([{ ...valid, stroke_order: 9, stroke_width: 99999 }, valid])
  assert.deepEqual(result.map((s) => s.stroke_order), [1, 2])
  assert.ok(result[0].stroke_width < 99999)
})

test('획 검증: 잘못된 입력은 오류', () => {
  assert.throws(() => sanitizeLayerStrokes('x'), /형식/)
  assert.throws(() => sanitizeLayerStrokes([{ ...valid, median_points: [[1, 1]] }]), /2점 이상/)
  assert.throws(() => sanitizeLayerStrokes([{ ...valid, outline_path: 'M 0 0 <script>' }]), /경로/)
})

test('획 검증: 중심선만 있으면 띠 모양 윤곽을 만든다', () => {
  const [stroke] = sanitizeLayerStrokes([{ ...valid, outline_path: '' }])
  assert.match(stroke.outline_path, /^M.* Z$/)
})

test('획 검증: font_contours는 정수만 중복 없이 정렬해 보존, font_hash는 16진수만', () => {
  const [kept] = sanitizeLayerStrokes([{ ...valid, font_contours: [3, 1, 1, -2, 1.5, 0], map_manual: 1, font_hash: 'abc123' }])
  assert.deepEqual(kept.font_contours, [0, 1, 3])
  assert.equal(kept.map_manual, 1)
  assert.equal(kept.font_hash, 'abc123')
  const [bad] = sanitizeLayerStrokes([{ ...valid, font_contours: [0], font_hash: 'XYZ<>' }])
  assert.equal(bad.font_hash, undefined)
  const [plain] = sanitizeLayerStrokes([valid])
  assert.equal(plain.font_contours, undefined)
})

test('윤곽 경로 검증', () => {
  assert.deepEqual(sanitizeLayerPaths([' M 0 0 L 1 1 Z ']), ['M 0 0 L 1 1 Z'])
  assert.throws(() => sanitizeLayerPaths(['bad']), /윤곽 경로/)
})

test('궁서체 지문은 같은 윤곽이면 같고 다르면 다르다', () => {
  const a = [rectPath(0, 0, 10, 10)]
  assert.equal(fontFingerprint(a), fontFingerprint([...a]))
  assert.notEqual(fontFingerprint(a), fontFingerprint([rectPath(0, 0, 10, 11)]))
  assert.equal(fontFingerprint(a).length, 12)
})

test('궁서체 윤곽 해석: 편집된 font 레이어 → 저장된 윤곽', () => {
  const layer = (paths: string[]) => [{ id: 'font', paths } as LayerRecord]
  assert.deepEqual(fontContoursOf({ layers: layer(['A']), font_outline: ['B'] }), ['A'])
  assert.deepEqual(fontContoursOf({ layers: layer([]), font_outline: ['B'] }), ['B'])
  assert.deepEqual(fontContoursOf({ layers: [], font_outline: [] }), [])
})
