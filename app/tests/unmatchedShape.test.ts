import assert from 'node:assert/strict'
import test from 'node:test'
import { ribbonPath, splitOutlinePieces } from '../server/geometry.ts'
import { DEFAULT_STROKE_WIDTH } from '../shared/constants.ts'
import type { Pt } from '../shared/types.ts'
import { rectPath } from './helpers.ts'

// 십자 모양 글자에 가로·세로 획과, 글자 한쪽 구석에 놓여 잉크를 못 가져가는 세 번째 획이 있다.
const CROSS = 'M 100 460 L 460 460 L 460 100 L 540 100 L 540 460 L 900 460 L 900 540 L 540 540 L 540 900 L 460 900 L 460 540 L 100 540 Z'
const HORIZONTAL: Pt[] = [[150, 500], [850, 500]]
const VERTICAL: Pt[] = [[500, 850], [500, 150]]
const CORNER: Pt[] = [[100, 100], [120, 120]]
// 구석 획의 길잡이 모양: 가늘고 작은 막대
const CORNER_SHAPE = rectPath(100, 100, 130, 112)

test('잉크를 못 찾은 획은 미매핑으로 남기되, 길잡이 모양이 있으면 고정 폭 띠가 아니라 그 모양을 쓴다', () => {
  const withoutShape = splitOutlinePieces([CROSS], [HORIZONTAL, VERTICAL, CORNER])
  assert.ok(withoutShape)
  assert.equal(withoutShape[2].contours.length, 0)
  assert.equal(withoutShape[2].width, DEFAULT_STROKE_WIDTH, '모양이 없으면 기본 폭 띠다')

  const withShape = splitOutlinePieces([CROSS], [HORIZONTAL, VERTICAL, CORNER], ['', '', CORNER_SHAPE])
  assert.ok(withShape)
  assert.equal(withShape[2].contours.length, 0, '여전히 미매핑이다')
  assert.notEqual(withShape[2].width, DEFAULT_STROKE_WIDTH)
  assert.notEqual(withShape[2].outline, ribbonPath(withShape[2].median, DEFAULT_STROKE_WIDTH))
})
