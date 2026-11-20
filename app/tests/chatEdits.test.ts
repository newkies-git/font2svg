import assert from 'node:assert/strict'
import test from 'node:test'
import { applyChatEdits, buildChatContext, describeEdit, type ChatEditActions } from '../src/lib/chatEdits.ts'
import { rectPath, strokeOf } from './helpers.ts'

function recorder() {
  const log: string[] = []
  const actions: ChatEditActions = {
    setRadical: (i, v) => log.push(`radical ${i} ${v}`),
    setCap: (i, end, v) => log.push(`cap ${i} ${end} ${v}`),
    reverse: (i) => log.push(`reverse ${i}`),
    move: (i, d) => log.push(`move ${i} ${d}`),
    remove: (i) => log.push(`remove ${i}`),
    mergeNext: (i) => log.push(`merge ${i}`),
  }
  return { log, actions }
}

test('수정 적용: 획 번호를 0부터로 바꾸고, 번호가 밀리는 수정은 마지막에 적용한다', () => {
  const { log, actions } = recorder()
  applyChatEdits(
    [
      { op: 'delete', stroke: 3 },
      { op: 'set_radical', stroke: 1, value: 1 },
      { op: 'set_cap', stroke: 2, end: 'start', value: 'TAPER' },
      { op: 'reverse', stroke: 2 },
    ],
    actions,
  )
  assert.deepEqual(log, ['radical 0 1', 'cap 1 start TAPER', 'reverse 1', 'remove 2'])
})

test('수정 설명은 사람이 읽는 문장이다', () => {
  assert.equal(describeEdit({ op: 'move', stroke: 2, delta: -1 }), '2획을 앞으로 1칸 이동')
  assert.equal(describeEdit({ op: 'merge_next', stroke: 1 }), '1획과 2획 병합')
  assert.equal(describeEdit({ op: 'set_radical', stroke: 1, value: 0 }), '1획 부수 해제')
})

test('채팅 컨텍스트: 레이어의 획을 요약하고, 글자가 없으면 만들지 않는다', () => {
  const layer = { name: '작업 획', strokes: [strokeOf(rectPath(0, 0, 10, 10), [[1, 2], [3, 4], [5, 6]], { is_radical: 1 })] }
  const context = buildChatContext({ char: '丁', reading: '정' }, layer)
  assert.deepEqual(context?.strokes[0], { order: 1, points: 3, width: 100, is_radical: 1, start_cap: 'NONE', end_cap: 'NONE', start: [1, 2], end: [5, 6] })
  assert.equal(context?.layerName, '작업 획')
  assert.equal(buildChatContext(null, layer), undefined)
  assert.deepEqual(buildChatContext({ char: '丁' }, null)?.strokes, [])
})
