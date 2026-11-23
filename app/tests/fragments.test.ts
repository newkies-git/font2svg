import assert from 'node:assert/strict'
import test from 'node:test'
import { dropFragments } from '../shared/strokeCut/bridge.ts'
import { rectPath } from './helpers.ts'

const BIG = rectPath(0, 0, 200, 200)
// 같은 방향으로 감긴 아주 작은 조각(파편)과, 반대 방향으로 감긴 구멍
const FRAGMENT = rectPath(300, 0, 304, 4)
const HOLE = 'M 50 50 L 50 150 L 150 150 L 150 50 Z'
const TINY_HOLE = 'M 300 300 L 300 304 L 304 304 L 304 300 Z'

test('파편 제거: 같은 방향의 작은 서브패스는 지우고 큰 것은 남긴다', () => {
  assert.deepEqual(dropFragments([BIG, FRAGMENT]), [BIG])
})

test('파편 제거: 반대 방향의 충분히 큰 구멍은 남기고, 점 크기 구멍은 지운다', () => {
  assert.deepEqual(dropFragments([BIG, HOLE]), [BIG, HOLE])
  assert.deepEqual(dropFragments([BIG, TINY_HOLE]), [BIG])
})

test('파편 제거: 서브패스가 하나면 그대로 둔다', () => {
  assert.deepEqual(dropFragments([FRAGMENT]), [FRAGMENT])
})
