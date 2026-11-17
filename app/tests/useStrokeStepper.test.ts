import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import { useStrokeStepper } from '../src/composables/useStrokeStepper.ts'

function setup(shownAt: number, count = 5) {
  const shown = ref(shownAt)
  const reveal = ref(0.4)
  const selected = ref(0)
  return { shown, reveal, selected, ...useStrokeStepper(() => count, shown, reveal, selected) }
}

test('다음은 한 획을 더 보이고 그 획을 선택하며 그리기를 끝낸다', () => {
  const s = setup(2)
  s.next()
  assert.deepEqual([s.shown.value, s.selected.value, s.reveal.value], [3, 2, 1])
})

test('이전은 한 획을 줄이고 줄어든 마지막 획을 선택한다', () => {
  const s = setup(3)
  s.prev()
  assert.deepEqual([s.shown.value, s.selected.value, s.reveal.value], [2, 1, 1])
})

test('처음은 첫 획만 보이고 선택한다', () => {
  const s = setup(4)
  s.first()
  assert.deepEqual([s.shown.value, s.selected.value, s.reveal.value], [1, 0, 1])
})

test('끝에서 다음, 처음에서 이전·처음은 아무것도 바꾸지 않는다', () => {
  const last = setup(5)
  last.next()
  assert.deepEqual([last.shown.value, last.selected.value, last.reveal.value], [5, 0, 0.4])
  const start = setup(1)
  start.prev()
  start.first()
  assert.deepEqual([start.shown.value, start.selected.value, start.reveal.value], [1, 0, 0.4])
})

test('획 수는 호출할 때마다 새로 읽는다(획이 줄어든 뒤에도 한도를 지킨다)', () => {
  const shown = ref(3)
  let count = 5
  const stepper = useStrokeStepper(() => count, shown, ref(1), ref(0))
  count = 3
  stepper.next()
  assert.equal(shown.value, 3)
})
