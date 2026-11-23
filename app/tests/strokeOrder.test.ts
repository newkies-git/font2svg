import assert from 'node:assert/strict'
import test from 'node:test'
import { matchStrokeOrder, reorderByMatch } from '../shared/strokeOrder.ts'
import type { Pt } from '../shared/types.ts'

// 十: 가로획 → 세로획 순서(NAVER)와, 같은 모양이지만 좌표계·순서가 다른 MMH(세로 → 가로)
const NAVER: Pt[][] = [[[100, 500], [900, 500]], [[500, 900], [500, 100]]]
const MMH: Pt[][] = [[[480, 820], [520, 0]], [[10, 450], [990, 470]]]

test('획순 짝짓기: NAVER의 i번째 획에 가장 닮은 MMH 획의 번호를 준다', () => {
  assert.deepEqual(matchStrokeOrder(NAVER, MMH), [1, 0])
})

test('획순 짝짓기: 순서가 같으면 항등, 방향이 반대인 획은 짝으로 삼지 않는다', () => {
  assert.deepEqual(matchStrokeOrder(NAVER, NAVER), [0, 1])
  const reversed: Pt[][] = [[[900, 500], [100, 500]], [[500, 900], [500, 100]]]
  assert.deepEqual(matchStrokeOrder(reversed, [NAVER[1], NAVER[0]]), [1, 0])
})

test('획순 짝짓기: 획 수가 다르거나 비어 있으면 null', () => {
  assert.equal(matchStrokeOrder(NAVER, [MMH[0]]), null)
  assert.equal(matchStrokeOrder([], []), null)
  assert.equal(matchStrokeOrder([[]], [[]]), null)
})

test('모양 목록을 짝짓기 결과대로 늘어놓는다', () => {
  assert.deepEqual(reorderByMatch(['가', '나', '다'], [2, 0, 1]), ['다', '가', '나'])
})
