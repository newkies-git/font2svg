import assert from 'node:assert/strict'
import test from 'node:test'
import type { LayerMetaPatch } from '../shared/types.ts'
import { mergeLayerMeta } from '../server/layerWrites.ts'

const current = { kind: 'CUSTOM', name: '기존', z_index: 3, visible: 1, opacity: 0.6, locked: 0, label_color: 'violet' } as const
const merge = (patch: Partial<LayerMetaPatch>) => mergeLayerMeta({ ...current }, { id: 'x', ...patch } as LayerMetaPatch)

test('요청이 비어 있으면 현재 설정을 그대로 둔다', () => {
  assert.deepEqual(merge({}), current)
})

test('올바른 값은 덮어쓰고 종류는 바꾸지 않는다', () => {
  assert.deepEqual(
    merge({ name: ' 새 이름 ', z_index: 7.6, visible: false, opacity: 0.25, locked: true, label_color: 'rose' }),
    { kind: 'CUSTOM', name: '새 이름', z_index: 8, visible: 0, opacity: 0.25, locked: 1, label_color: 'rose' },
  )
})

test('이름은 공백뿐이거나 문자열이 아니면 현재 이름을 유지한다', () => {
  for (const name of ['', '   ', 5, null]) assert.equal(merge({ name: name as never }).name, '기존', String(name))
})

test('순서는 유한한 숫자일 때만 반영한다', () => {
  for (const z_index of [Number.NaN, Infinity, '2', null]) assert.equal(merge({ z_index: z_index as never }).z_index, 3, String(z_index))
  assert.equal(merge({ z_index: 0 }).z_index, 0)
})

test('표시·잠금은 boolean일 때만 반영하고 0/1로 저장한다', () => {
  for (const value of [0, 1, 'true', null]) {
    const merged = merge({ visible: value as never, locked: value as never })
    assert.deepEqual([merged.visible, merged.locked], [1, 0], String(value))
  }
  assert.deepEqual([merge({ visible: false }).visible, merge({ locked: true }).locked], [0, 1])
})

test('불투명도와 색상은 허용 범위·목록을 벗어나면 현재 값으로 돌아간다', () => {
  assert.equal(merge({ opacity: 'x' as never }).opacity, 0.6)
  assert.equal(merge({ opacity: 5 }).opacity, 1, '범위를 넘으면 가장자리로 맞춘다')
  assert.equal(merge({ label_color: 'bogus' as never }).label_color, 'violet')
  assert.equal(merge({ label_color: 'none' }).label_color, 'none')
})

test('참고 레이어(MMH·ACJK·NAVER)는 항상 잠금(1)을 유지한다', () => {
  for (const kind of ['MMH', 'ACJK', 'NAVER'] as const) {
    const ref = { ...current, kind, locked: 0 }
    assert.equal(mergeLayerMeta(ref, { id: 'x' }).locked, 1, `${kind} 빈 패치`)
    assert.equal(mergeLayerMeta(ref, { id: 'x', locked: false }).locked, 1, `${kind} 잠금 해제 시도`)
  }
})
