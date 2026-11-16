import assert from 'node:assert/strict'
import test from 'node:test'
import { NUDGE_STEP } from '../src/lib/constants.ts'
import { resolveKeyAction, type KeyContext } from '../src/lib/keymap.ts'

const press = (key: string, over: Partial<KeyContext> = {}) =>
  resolveKeyAction({ key, meta: false, ctrl: false, alt: false, shift: false, activeTool: 'select', canNudge: true, ...over })

test('Ctrl/Cmd+S 저장, Ctrl/Cmd+Z 되돌리기(Shift 제외), 다른 조합은 무시', () => {
  assert.deepEqual(press('s', { ctrl: true }), { type: 'save' })
  assert.deepEqual(press('S', { meta: true }), { type: 'save' })
  assert.deepEqual(press('z', { meta: true }), { type: 'undo' })
  assert.equal(press('z', { meta: true, shift: true }), null)
  assert.equal(press('v', { ctrl: true }), null, '수정 키와 함께 누른 도구 키는 도구를 바꾸지 않는다')
  assert.equal(press('v', { alt: true }), null)
})

test('도구 단축키는 대소문자를 구분하지 않는다', () => {
  assert.deepEqual(press('v'), { type: 'tool', tool: 'select' })
  assert.deepEqual(press('A'), { type: 'tool', tool: 'bezier' })
  assert.deepEqual(press('m'), { type: 'tool', tool: 'median' })
  assert.deepEqual(press('K'), { type: 'tool', tool: 'knife' })
  assert.deepEqual(press('p'), { type: 'tool', tool: 'connect' })
  assert.equal(press('q'), null)
})

test('윤곽 연결 도구에서만 Enter·Backspace가 동작한다', () => {
  assert.deepEqual(press('Enter', { activeTool: 'connect' }), { type: 'commitConnect' })
  assert.deepEqual(press('Backspace', { activeTool: 'connect' }), { type: 'undoConnectPoint' })
  assert.equal(press('Enter'), null)
  assert.equal(press('Backspace'), null)
})

test('Shift+방향키: 선택 도구·편집 가능일 때 NUDGE_STEP만큼 옮긴다(y는 위가 +)', () => {
  assert.deepEqual(press('ArrowLeft', { shift: true }), { type: 'nudge', dx: -NUDGE_STEP, dy: 0 })
  assert.deepEqual(press('ArrowRight', { shift: true }), { type: 'nudge', dx: NUDGE_STEP, dy: 0 })
  assert.deepEqual(press('ArrowUp', { shift: true }), { type: 'nudge', dx: 0, dy: NUDGE_STEP })
  assert.deepEqual(press('ArrowDown', { shift: true }), { type: 'nudge', dx: 0, dy: -NUDGE_STEP })
})

test('Shift+방향키가 옮기기 불가면 일반 방향키로 처리한다', () => {
  assert.deepEqual(press('ArrowLeft', { shift: true, canNudge: false }), { type: 'stepPrev' })
  assert.deepEqual(press('ArrowRight', { shift: true, activeTool: 'knife' }), { type: 'stepNext' })
  assert.equal(press('ArrowUp', { shift: true, canNudge: false }), null)
})

test('재생·획 이동·취소 키', () => {
  assert.deepEqual(press('ArrowLeft'), { type: 'stepPrev' })
  assert.deepEqual(press('ArrowRight'), { type: 'stepNext' })
  assert.deepEqual(press(' '), { type: 'togglePlay' })
  assert.deepEqual(press('Escape'), { type: 'cancel' })
})
