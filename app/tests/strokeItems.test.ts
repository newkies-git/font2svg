import assert from 'node:assert/strict'
import test from 'node:test'
import { strokeWidthCap } from '../shared/clamp.ts'
import { DEFAULT_STROKE_WIDTH, MIN_STROKE_WIDTH } from '../shared/constants.ts'
import type { StrokeItem } from '../server/model.ts'
import { itemsOf, sanitizedItems } from '../server/strokeStore.ts'

const item = (overrides: Partial<StrokeItem> = {}): StrokeItem => ({
  outline_path: 'M0 0 L10 0 L10 10 Z',
  median_points: [[0.04, 0], [10.06, 5]],
  stroke_width: DEFAULT_STROKE_WIDTH,
  is_radical: 0,
  start_cap_type: 'NONE',
  end_cap_type: 'NONE',
  ...overrides,
})

test('획 폭은 허용 범위로 맞추고 0이나 숫자가 아닌 값은 기본 폭이 된다', () => {
  const widths = [1, 100000, 0, Number.NaN].map((stroke_width) => sanitizedItems([item({ stroke_width })])[0].stroke_width)
  assert.deepEqual(widths, [MIN_STROKE_WIDTH, strokeWidthCap(), DEFAULT_STROKE_WIDTH, DEFAULT_STROKE_WIDTH])
})

test('알 수 없는 끝 모양은 NONE이 되고 부수 표시는 0/1로 정리된다', () => {
  const [result] = sanitizedItems([item({ start_cap_type: 'AUTO_ROUND', end_cap_type: 'BOGUS' as never, is_radical: 7 as never })])
  assert.deepEqual([result.start_cap_type, result.end_cap_type, result.is_radical], ['AUTO_ROUND', 'NONE', 1])
})

test('중심선이 점 하나뿐인 획은 몇 번째 획인지 알려 주며 거부한다', () => {
  assert.throws(() => sanitizedItems([item(), item({ median_points: [[1, 1]] })]), /2획의 중심선이 없습니다/)
})

test('중심선 좌표는 소수 첫째 자리까지 반올림한다', () => {
  const [result] = sanitizedItems([item({ median_points: [[0.04, 0.06], [10.06, 5]] })])
  assert.deepEqual(result.median_points, [[0, 0.1], [10.1, 5]])
})

test('저장된 윤곽과 중심선 JSON을 획 순서로 이어 붙인다', () => {
  const rows = {
    stroke_outlines: JSON.stringify([{ order: 2, path: 'B', radical: 0 }, { order: 1, path: 'A', radical: 1 }]),
    median_line: JSON.stringify([
      { order: 1, points: [[0, 0], [1, 1]], width: 100, start_cap: 'AUTO_ROUND', end_cap: 'x' },
      { order: 2, points: [[2, 2], [3, 3]], width: 120, start_cap: 'NONE', end_cap: 'NONE' },
    ]),
  }
  const items = itemsOf(rows)
  assert.deepEqual(items.map((entry) => entry.outline_path), ['B', 'A'])
  assert.deepEqual(items.map((entry) => entry.stroke_width), [120, 100])
  assert.deepEqual([items[1].is_radical, items[1].start_cap_type, items[1].end_cap_type], [1, 'AUTO_ROUND', 'NONE'])
})

test('윤곽에 짝이 되는 중심선이 없으면 던진다', () => {
  assert.throws(() => itemsOf({ stroke_outlines: JSON.stringify([{ order: 1, path: 'A', radical: 0 }]), median_line: '[]' }), /1획의 중심선 데이터가 없습니다/)
})
