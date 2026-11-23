import assert from 'node:assert/strict'
import test from 'node:test'
import { splitOutlinePieces } from '../server/geometry.ts'
import type { Pt } from '../shared/types.ts'
import { pathBounds } from './helpers.ts'

// T 모양 글자: 가로 막대(y 760~840)와 그 아래로 내려오는 세로 막대(x 460~540, y 100~760)
const T_GLYPH = 'M 100 760 L 460 760 L 460 100 L 540 100 L 540 760 L 900 760 L 900 840 L 100 840 Z'
const BAR: Pt[] = [[150, 800], [850, 800]]
const STEM: Pt[] = [[500, 150], [500, 800]]
const BAR_BOTTOM = 760

test('분할한 획의 끝이 이웃 획 안으로 이어진다: 세로 막대의 윗끝이 가로 막대 밑면을 넘어 들어간다', () => {
  const pieces = splitOutlinePieces([T_GLYPH], [BAR, STEM])
  assert.ok(pieces)
  assert.equal(pieces.filter((piece) => piece.contours.length === 0).length, 0)
  const stem = pieces.find((piece) => pathBounds(piece.outline).maxX - pathBounds(piece.outline).minX < 200)
  assert.ok(stem, '세로 막대 조각')
  assert.ok(pathBounds(stem.outline).maxY > BAR_BOTTOM + 5, `세로 막대 윗끝 ${pathBounds(stem.outline).maxY}가 막대 밑면 ${BAR_BOTTOM}을 넘어야 한다`)
})

test('중심선 끝이 절단면에서 멈추지 않고 획 윤곽 끝 가까이까지 닿는다', () => {
  const pieces = splitOutlinePieces([T_GLYPH], [BAR, STEM])
  assert.ok(pieces)
  const stem = pieces.find((piece) => pathBounds(piece.outline).maxX - pathBounds(piece.outline).minX < 200)
  assert.ok(stem, '세로 막대 조각')
  const bounds = pathBounds(stem.outline)
  const top = Math.max(...stem.median.map(([, y]) => y))
  const bottom = Math.min(...stem.median.map(([, y]) => y))
  const tipMargin = stem.width
  assert.ok(top >= bounds.maxY - tipMargin, `윗끝 ${top}이 윤곽 끝 ${bounds.maxY}에서 ${tipMargin} 이내여야 한다`)
  assert.ok(bottom <= bounds.minY + tipMargin, `아랫끝 ${bottom}이 윤곽 끝 ${bounds.minY}에서 ${tipMargin} 이내여야 한다`)
})
