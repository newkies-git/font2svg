import assert from 'node:assert/strict'
import test from 'node:test'
import { describeEdit } from '../src/lib/chatEdits.ts'

test('수정 설명은 사람이 읽는 문장이다', () => {
  assert.equal(describeEdit({ op: 'move', stroke: 2, delta: -1 }), '2획을 앞으로 1칸 이동')
  assert.equal(describeEdit({ op: 'merge_next', stroke: 1 }), '1획과 2획 병합')
  assert.equal(describeEdit({ op: 'set_radical', stroke: 1, value: 0 }), '1획 부수 해제')
  assert.equal(describeEdit({ op: 'set_cap', stroke: 3, end: 'end', value: 'POINTED' }), '3획 수필 모양: 뾰족')
})
