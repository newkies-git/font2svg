import assert from 'node:assert/strict'
import test from 'node:test'
import { REFERENCE_PRIORITY, referenceRank } from '../shared/layerKind.ts'

test('참고 출처 우선순위: NAVER가 가장 앞이고 모르는 출처는 맨 뒤다', () => {
  assert.deepEqual(REFERENCE_PRIORITY, ['NAVER', 'MMH'])
  assert.ok(referenceRank('NAVER') < referenceRank('MMH'))
  assert.ok(referenceRank('MMH') < referenceRank('OTHER'))
  assert.equal(referenceRank('OTHER'), REFERENCE_PRIORITY.length)
})
