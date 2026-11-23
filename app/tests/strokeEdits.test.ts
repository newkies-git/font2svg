import assert from 'node:assert/strict'
import test from 'node:test'
import { applyStrokeEdits, sanitizeEdits } from '../server/strokeEdits.ts'
import { rectPath, strokeOf } from './helpers.ts'

const bar = (y: number, overrides = {}) => strokeOf(rectPath(100, y, 400, y + 60), [[110, y + 30], [390, y + 30]], overrides)
const three = () => [bar(100, { stroke_order: 1 }), bar(300, { stroke_order: 2 }), bar(500, { stroke_order: 3 })]

test('수정 제안 검증: 범위 밖·모르는 op는 버리고 번호가 밀리는 수정은 하나만 받는다', () => {
  const edits = sanitizeEdits(
    [
      { op: 'set_radical', stroke: 1, value: 1 },
      { op: 'set_radical', stroke: 9, value: 1 },
      { op: 'set_cap', stroke: 2, end: 'end', value: 'POINTED' },
      { op: 'set_cap', stroke: 2, end: 'middle', value: 'POINTED' },
      { op: 'set_cap', stroke: 2, end: 'end', value: 'WRONG' },
      { op: 'explode', stroke: 1 },
      { op: 'delete', stroke: 3 },
      { op: 'merge_next', stroke: 1 },
      { op: 'reverse', stroke: 2 },
    ],
    3,
  )
  assert.deepEqual(edits, [
    { op: 'set_radical', stroke: 1, value: 1 },
    { op: 'set_cap', stroke: 2, end: 'end', value: 'POINTED' },
    { op: 'delete', stroke: 3 },
    { op: 'reverse', stroke: 2 },
  ])
  assert.deepEqual(sanitizeEdits('x', 3), [])
  assert.deepEqual(sanitizeEdits([{ op: 'delete', stroke: 1 }], 1), [])
  assert.deepEqual(sanitizeEdits([{ op: 'move', stroke: 3, delta: 1 }], 3), [])
  assert.deepEqual(sanitizeEdits([{ op: 'merge_next', stroke: 3 }], 3), [])
})

test('수정 적용: 번호가 밀리지 않는 수정을 먼저 적용하고 획 번호를 다시 매긴다', () => {
  const original = three()
  const result = applyStrokeEdits(original, [
    { op: 'delete', stroke: 1 },
    { op: 'set_radical', stroke: 1, value: 1 },
    { op: 'reverse', stroke: 2 },
  ])
  assert.equal(result.length, 2)
  assert.deepEqual(result.map((s) => s.stroke_order), [1, 2])
  // 삭제 전 번호 기준으로 2획이던 획이 반전되고, 1획이던 획은 삭제된다.
  assert.deepEqual(result[0].median_points, [[390, 330], [110, 330]])
  assert.equal(result[0].is_radical, 0)
  assert.equal(original.length, 3, '원본은 바꾸지 않는다')
  assert.equal(original[0].is_radical, 0)
})

test('수정 적용: 순서 이동과 병합', () => {
  assert.deepEqual(applyStrokeEdits(three(), [{ op: 'move', stroke: 1, delta: 2 }]).map((s) => s.median_points[0][1]), [330, 530, 130])
  const merged = applyStrokeEdits(three(), [{ op: 'merge_next', stroke: 1 }])
  assert.equal(merged.length, 2)
  assert.throws(() => applyStrokeEdits(three(), [{ op: 'delete', stroke: 9 }]), /없습니다/)
})
