import assert from 'node:assert/strict'
import test from 'node:test'
import { orderedGlyph } from '../server/referenceMerge.ts'
import type { HanjaGlyph } from '../server/references.ts'
import { rectPath } from './helpers.ts'

const horizontal = { median: [[100, 500], [900, 500]] as [number, number][], outline: rectPath(100, 460, 900, 540) }
const vertical = { median: [[500, 900], [500, 100]] as [number, number][], outline: rectPath(460, 100, 540, 900) }
const glyph = (strokes: typeof horizontal[], radical: number[] = []): HanjaGlyph => ({ medians: strokes.map((s) => s.median), outlines: strokes.map((s) => s.outline), radical })

test('획순은 NAVER, 모양은 MMH: MMH 획을 NAVER 순서로 늘어놓고 부수 표시도 따라 옮긴다', () => {
  const naver = glyph([horizontal, vertical])
  const mmh = glyph([vertical, horizontal], [0])
  const merged = orderedGlyph(naver, mmh)
  assert.ok(merged)
  assert.equal(merged.shape, 'MMH')
  assert.deepEqual(merged.outlines, [horizontal.outline, vertical.outline])
  assert.deepEqual(merged.radical, [1], 'MMH의 0번(세로) 획이 합친 순서의 1번이 된다')
})

test('MMH가 없거나 획 수가 다르면 NAVER 획을 그대로 쓴다', () => {
  const naver = glyph([horizontal, vertical], [1])
  const alone = orderedGlyph(naver, null)
  assert.equal(alone?.shape, 'NAVER')
  assert.deepEqual(alone?.radical, [1])
  assert.equal(orderedGlyph(naver, glyph([horizontal]))?.shape, 'NAVER')
})

test('NAVER에서 쓸 획이 없으면 null', () => {
  assert.equal(orderedGlyph({ medians: [], outlines: [], radical: [] }, null), null)
})
