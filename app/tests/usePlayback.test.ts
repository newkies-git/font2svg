import assert from 'node:assert/strict'
import test, { afterEach, beforeEach, mock } from 'node:test'
import { ref } from 'vue'
import { REVEAL_STEP, REVEAL_STROKE_MS } from '../shared/constants.ts'
import { usePlayback } from '../src/composables/usePlayback.ts'

type Frame = (timestamp: number) => void
let frames: Map<number, Frame>
let nextId: number
let reduced: boolean
let motionListener: ((event: { matches: boolean }) => void) | null
const globals = globalThis as unknown as { window?: unknown }

// 브라우저 API(requestAnimationFrame, matchMedia)를 흉내 낸다. 시험이 프레임을 직접 돌린다.
beforeEach(() => {
  frames = new Map()
  nextId = 1
  reduced = false
  motionListener = null
  mock.method(console, 'warn', () => {})
  globals.window = {
    requestAnimationFrame: (callback: Frame) => { frames.set(nextId, callback); return nextId++ },
    cancelAnimationFrame: (id: number) => { frames.delete(id) },
    matchMedia: () => ({
      get matches() { return reduced },
      addEventListener: (_: string, listener: (event: { matches: boolean }) => void) => { motionListener = listener },
      removeEventListener: () => { motionListener = null },
    }),
  }
})
afterEach(() => {
  delete globals.window
  mock.restoreAll()
})

function tick(timestamp: number) {
  const [id, frame] = [...frames][0]
  frames.delete(id)
  frame(timestamp)
}

test('재생: 첫 획부터 시작하고 경과 시간에 비례해 획을 그린 뒤 다음 획으로 넘어간다', () => {
  const shown = ref(0)
  const reveal = ref(1)
  const playback = usePlayback(() => 3, shown, reveal)
  playback.play()
  assert.equal(playback.playing.value, true)
  assert.equal(shown.value, 1)
  assert.equal(reveal.value, 0)
  tick(1000) // 첫 프레임은 기준 시간만 잡고 작은 기본 증분만큼 진행
  assert.equal(reveal.value, REVEAL_STEP)
  tick(1000 + REVEAL_STROKE_MS / 2)
  assert.ok(Math.abs(reveal.value - (REVEAL_STEP + 0.5)) < 1e-9)
  tick(1000 + REVEAL_STROKE_MS * 2) // 한 획을 넘겨 다 그림 → 다음 획
  assert.equal(shown.value, 2)
  assert.equal(reveal.value, 0)
  assert.equal(playback.playing.value, true)
})

test('재생: 마지막 획을 다 그리면 멈춘다', () => {
  const shown = ref(0)
  const reveal = ref(1)
  const playback = usePlayback(() => 2, shown, reveal)
  playback.play()
  let time = 1000
  for (let guard = 0; guard < 20 && playback.playing.value; guard++) {
    tick(time)
    time += REVEAL_STROKE_MS * 2
  }
  assert.equal(playback.playing.value, false)
  assert.equal(shown.value, 2)
  assert.equal(reveal.value, 1)
  assert.equal(frames.size, 0, '멈춘 뒤에는 다음 프레임을 예약하지 않는다')
})

test('멈춤: 예약된 프레임을 취소한다', () => {
  const playback = usePlayback(() => 3, ref(0), ref(1))
  playback.play()
  assert.equal(frames.size, 1)
  playback.stop()
  assert.equal(frames.size, 0)
  assert.equal(playback.playing.value, false)
})

test('획이 없으면 재생하지 않는다', () => {
  const shown = ref(0)
  const playback = usePlayback(() => 0, shown, ref(1))
  playback.play()
  assert.equal(playback.playing.value, false)
  assert.equal(frames.size, 0)
})

test('모두 보기: 재생을 멈추고 전체 획을 완성된 상태로 보인다', () => {
  const shown = ref(1)
  const reveal = ref(0.2)
  const playback = usePlayback(() => 5, shown, reveal)
  playback.play()
  playback.showAll()
  assert.equal(playback.playing.value, false)
  assert.equal(shown.value, 5)
  assert.equal(reveal.value, 1)
})

test('움직임 줄이기 설정이면 애니메이션 없이 전체를 보인다', () => {
  reduced = true
  const shown = ref(0)
  const reveal = ref(0)
  const playback = usePlayback(() => 4, shown, reveal)
  playback.play()
  assert.equal(playback.playing.value, false)
  assert.equal(frames.size, 0)
  assert.equal(shown.value, 4)
  assert.equal(reveal.value, 1)
})

test('움직임 줄이기 설정이 바뀌면 다음 재생부터 따른다', () => {
  const shown = ref(0)
  const reveal = ref(1)
  const playback = usePlayback(() => 4, shown, reveal)
  motionListener!({ matches: true })
  playback.play()
  assert.equal(playback.playing.value, false)
  assert.equal(shown.value, 4)
  motionListener!({ matches: false })
  playback.play()
  assert.equal(playback.playing.value, true)
})
