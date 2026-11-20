import assert from 'node:assert/strict'
import test, { beforeEach, mock } from 'node:test'
import { ref } from 'vue'
import { NUDGE_STEP } from '../shared/constants.ts'
import type { CharacterDetail, EditorTool } from '../shared/types.ts'
import { useStudioShortcuts, type StudioShortcutDeps } from '../src/composables/useStudioShortcuts.ts'

// 컴포넌트 밖에서 부르면 Vue가 생명주기 훅 경고를 내므로 막는다.
beforeEach(() => mock.method(console, 'warn', () => {}))

const detail = (historyCount: number) => ({ history_count: historyCount }) as CharacterDetail

function setup(overrides: Partial<StudioShortcutDeps> = {}) {
  const calls: string[] = []
  const log = (name: string) => () => { calls.push(name) }
  const deps: StudioShortcutDeps = {
    selected: ref(detail(1)),
    busy: ref(false),
    activeTool: ref<EditorTool>('select'),
    isEditableLocked: ref(false),
    playing: ref(false),
    hasKnifePoints: () => false,
    hasConnectPoints: () => false,
    save: log('save'),
    undo: log('undo'),
    selectTool: (tool) => { calls.push(`tool:${tool}`) },
    commitConnect: log('commitConnect'),
    undoConnectPoint: log('undoConnectPoint'),
    nudge: (move) => { calls.push(`nudge:${move(10, 10).join(',')}`) },
    stepPrev: log('stepPrev'),
    stepNext: log('stepNext'),
    play: log('play'),
    stop: log('stop'),
    cancelKnife: log('cancelKnife'),
    cancelConnect: log('cancelConnect'),
    ...overrides,
  }
  const { onKeyDown } = useStudioShortcuts(deps)
  const press = (key: string, init: Partial<KeyboardEvent> = {}, tag = 'DIV') => {
    let prevented = false
    onKeyDown({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init, target: { tagName: tag }, preventDefault: () => { prevented = true } } as unknown as KeyboardEvent)
    return prevented
  }
  return { calls, press, deps }
}

test('입력창에서 누른 키와 글자를 고르지 않았을 때의 키는 무시한다', () => {
  const typing = setup()
  typing.press('k', {}, 'INPUT')
  assert.deepEqual(typing.calls, [])
  const empty = setup({ selected: ref(null) })
  empty.press('k')
  assert.deepEqual(empty.calls, [])
})

test('도구 키는 도구를 고르고 기본 동작을 막는다', () => {
  const { calls, press } = setup()
  assert.equal(press('k'), true)
  assert.deepEqual(calls, ['tool:knife'])
})

test('저장·실행 취소는 작업 중이면 하지 않고, 취소할 이력이 없어도 하지 않는다', () => {
  const idle = setup()
  idle.press('s', { metaKey: true })
  idle.press('z', { metaKey: true })
  assert.deepEqual(idle.calls, ['save', 'undo'])
  const busy = setup({ busy: ref(true) })
  busy.press('s', { metaKey: true })
  busy.press('z', { metaKey: true })
  assert.deepEqual(busy.calls, [])
  const noHistory = setup({ selected: ref(detail(0)) })
  noHistory.press('z', { metaKey: true })
  assert.deepEqual(noHistory.calls, [])
})

test('방향키는 단계 이동, Shift+방향키는 편집 가능할 때만 이동으로 이어진다', () => {
  const { calls, press } = setup()
  press('ArrowLeft')
  press('ArrowRight')
  press('ArrowUp', { shiftKey: true })
  assert.deepEqual(calls, ['stepPrev', 'stepNext', `nudge:10,${10 + NUDGE_STEP}`])
  const locked = setup({ isEditableLocked: ref(true) })
  locked.press('ArrowUp', { shiftKey: true })
  assert.ok(!locked.calls.some((call) => call.startsWith('nudge')))
})

test('스페이스는 재생 중이면 멈추고 아니면 재생한다', () => {
  const stopped = setup()
  stopped.press(' ')
  const playing = setup({ playing: ref(true) })
  playing.press(' ')
  assert.deepEqual([stopped.calls, playing.calls], [['play'], ['stop']])
})

test('Esc는 칼 점이 있으면 칼을, 없고 연결 점이 있으면 연결을 취소하며 기본 동작은 막지 않는다', () => {
  const knife = setup({ hasKnifePoints: () => true, hasConnectPoints: () => true })
  assert.equal(knife.press('Escape'), false)
  assert.deepEqual(knife.calls, ['cancelKnife'])
  const connect = setup({ hasConnectPoints: () => true })
  connect.press('Escape')
  assert.deepEqual(connect.calls, ['cancelConnect'])
  const none = setup()
  none.press('Escape')
  assert.deepEqual(none.calls, [])
})

test('정점 편집(bezier)에서 Delete·Backspace는 정점 삭제, Shift+방향키는 미세 이동, Esc는 선택 해제로 이어진다', () => {
  const calls: string[] = []
  const bezier = setup({
    activeTool: ref<EditorTool>('bezier'),
    hasSelectedPathPoints: () => true,
    deletePathPoints: () => calls.push('deletePathPoints'),
    clearPathPoints: () => calls.push('clearPathPoints'),
    nudgePathPoints: (dx, dy) => calls.push(`nudgePathPoints:${dx},${dy}`),
  })
  assert.equal(bezier.press('Delete'), true)
  assert.equal(bezier.press('Backspace'), true)
  assert.equal(bezier.press('ArrowRight', { shiftKey: true }), true)
  assert.equal(bezier.press('Escape'), false)
  assert.deepEqual(calls, ['deletePathPoints', 'deletePathPoints', `nudgePathPoints:${NUDGE_STEP},0`, 'clearPathPoints'])

  // 선택된 정점이 없으면 Shift+방향키와 Delete가 동작하지 않는다
  const emptyCalls: string[] = []
  const emptySelection = setup({
    activeTool: ref<EditorTool>('bezier'),
    hasSelectedPathPoints: () => false,
    deletePathPoints: () => emptyCalls.push('deletePathPoints'),
    nudgePathPoints: (dx, dy) => emptyCalls.push(`nudgePathPoints:${dx},${dy}`),
  })
  emptySelection.press('Delete')
  emptySelection.press('ArrowRight', { shiftKey: true })
  assert.deepEqual(emptyCalls, [])
})
