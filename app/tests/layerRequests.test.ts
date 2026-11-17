import assert from 'node:assert/strict'
import test from 'node:test'
import { LAYER_BATCH_LIMIT } from '../shared/constants.ts'
import { parseLayerBatch, parseLayerSavePayload, parseResegmentMedians } from '../server/layerRequests.ts'

test('레이어 일괄 저장은 id와 내용만 골라 정리한다', () => {
  const batch = parseLayerBatch([{ id: 'a', strokes: [1], paths: ['M0 0'], action: '편집', extra: 1 }, { id: 'b', action: 5 }])
  assert.deepEqual(batch, [
    { id: 'a', payload: { strokes: [1], paths: ['M0 0'], action: '편집' } },
    { id: 'b', payload: { strokes: undefined, paths: undefined, action: undefined } },
  ])
})

test('비었거나 배열이 아니거나 한도를 넘으면 던진다', () => {
  assert.throws(() => parseLayerBatch([]), /비어 있습니다/)
  assert.throws(() => parseLayerBatch('x'), /비어 있습니다/)
  const many = Array.from({ length: LAYER_BATCH_LIMIT + 1 }, (_, index) => ({ id: `l${index}` }))
  assert.throws(() => parseLayerBatch(many), new RegExp(`${LAYER_BATCH_LIMIT}개까지`))
})

test('id가 없거나 문자열이 아니거나 겹치면 몇 번째인지 알려 주며 던진다', () => {
  assert.throws(() => parseLayerBatch([{ id: 'a' }, {}]), /2번째 레이어에 id가 없습니다/)
  assert.throws(() => parseLayerBatch([null]), /1번째 레이어에 id가 없습니다/)
  assert.throws(() => parseLayerBatch([{ id: 7 }]), /id가 없습니다/)
  assert.throws(() => parseLayerBatch([{ id: 'a' }, { id: 'a' }]), /'a'가 중복/)
})

test('재분할 중심선은 소수 첫째 자리로 반올림하고 점이 둘 미만이면 몇 획인지 알려 준다', () => {
  assert.deepEqual(parseResegmentMedians([[[0.04, 0.06], [10.06, 5]]]), [[[0, 0.1], [10.1, 5]]])
  assert.throws(() => parseResegmentMedians([[[0, 0], [1, 1]], [[1, 1]]]), /2획 중심선은 2점 이상/)
  assert.throws(() => parseResegmentMedians([]), /비어 있습니다/)
  assert.throws(() => parseResegmentMedians(null), /비어 있습니다/)
})

test('저장 요청 한 건은 내용만 골라 정리하고 action은 문자열일 때만 받는다', () => {
  assert.deepEqual(parseLayerSavePayload({ strokes: [1], paths: ['M0 0'], action: '편집', extra: 1 } as never), { strokes: [1], paths: ['M0 0'], action: '편집' })
  assert.deepEqual(parseLayerSavePayload({ action: 3 }), { strokes: undefined, paths: undefined, action: undefined })
})
