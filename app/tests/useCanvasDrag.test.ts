import assert from 'node:assert/strict'
import test, { afterEach, beforeEach, mock } from 'node:test'
import { useCanvasDrag } from '../src/composables/useCanvasDrag.ts'
import type { LayerRecord, Pt, StrokeRecord } from '../shared/types.ts'
import { bar, layerOf } from './studioHarness.ts'

const globals = globalThis as unknown as { window?: EventTarget }
let target: EventTarget

beforeEach(() => {
  target = new EventTarget()
  globals.window = target
  mock.method(console, 'warn', () => {})
})
afterEach(() => {
  delete globals.window
  mock.restoreAll()
})

type FakePointer = Event & { pt: Pt | null; shiftKey: boolean; altKey: boolean }
const pointer = (type: string, pt: Pt | null, flags: { shiftKey?: boolean; altKey?: boolean } = {}): FakePointer =>
  Object.assign(new Event(type, { cancelable: true }), { pt, shiftKey: flags.shiftKey ?? false, altKey: flags.altKey ?? false })
const asPointer = (event: FakePointer) => event as unknown as PointerEvent

function setup(options: { locked?: boolean; layer?: LayerRecord | null; mode?: 'scale' | 'rotate' | 'skew' | 'distort'; bezier?: string | null } = {}) {
  const layer = options.layer === undefined ? layerOf('strokes', 'STROKES', { strokes: [bar(100), bar(300)] }) : options.layer
  const emitted: { name: string; args: unknown[] }[] = []
  const record = (name: string) => (...args: unknown[]) => { emitted.push({ name, args }) }
  const drag = useCanvasDrag({
    editableLayer: () => layer,
    locked: () => options.locked ?? false,
    selectedIndex: () => 1,
    activeBBox: () => ({ minX: 100, minY: 100, maxX: 500, maxY: 360 }),
    transformMode: () => options.mode ?? 'scale',
    targetBezierPath: () => options.bezier ?? null,
    eventToFont: (event) => (event as unknown as FakePointer).pt,
    emit: {
      restoreSnapshot: record('restoreSnapshot') as (s: StrokeRecord[], p: string[]) => void,
      transformBy: record('transformBy') as (fn: (x: number, y: number) => Pt, scale: number) => void,
      updatePath: record('updatePath'),
      moveMedianVertex: record('moveMedianVertex'),
      addMedianVertex: record('addMedianVertex'),
      deleteMedianVertex: record('deleteMedianVertex'),
    },
  })
  return { drag, emitted, layer }
}

const move = (pt: Pt | null, flags?: { shiftKey?: boolean }) => target.dispatchEvent(pointer('pointermove', pt, flags))
const release = () => target.dispatchEvent(pointer('pointerup', null))

test('이동 드래그: 움직일 때마다 시작 상태로 되돌린 뒤 이동량만큼 옮긴다', () => {
  const { drag, emitted } = setup()
  drag.startMoveDrag(asPointer(pointer('pointerdown', [200, 200])))
  move([230, 190])
  assert.deepEqual(emitted.map((item) => item.name), ['restoreSnapshot', 'transformBy'])
  const fn = emitted[1].args[0] as (x: number, y: number) => Pt
  assert.deepEqual(fn(100, 100), [130, 90])
  assert.equal(emitted[1].args[1], 1)
  const snapshot = emitted[0].args[0] as StrokeRecord[]
  assert.equal(snapshot.length, 2)
  assert.notEqual(snapshot[0], setup().layer!.strokes[0], '복제본이어야 한다')
  move([260, 180]) // 이전 이동이 쌓이지 않고 시작점 기준으로 다시 계산된다
  const second = emitted[3].args[0] as (x: number, y: number) => Pt
  assert.deepEqual(second(100, 100), [160, 80])
})

test('이동 드래그: 포인터를 놓으면 더 이상 반응하지 않는다', () => {
  const { drag, emitted } = setup()
  drag.startMoveDrag(asPointer(pointer('pointerdown', [0, 0])))
  release()
  move([10, 10])
  assert.equal(emitted.length, 0)
})

test('위치를 못 구하는 움직임(캔버스 밖)은 무시한다', () => {
  const { drag, emitted } = setup()
  drag.startMoveDrag(asPointer(pointer('pointerdown', [0, 0])))
  move(null)
  assert.equal(emitted.length, 0)
})

test('잠겼거나 편집 대상이 없거나 시작 위치를 못 구하면 드래그를 시작하지 않는다', () => {
  for (const options of [{ locked: true }, { layer: null }]) {
    const { drag, emitted } = setup(options)
    drag.startMoveDrag(asPointer(pointer('pointerdown', [0, 0])))
    move([5, 5])
    assert.equal(emitted.length, 0)
  }
  const { drag, emitted } = setup()
  drag.startMoveDrag(asPointer(pointer('pointerdown', null)))
  move([5, 5])
  assert.equal(emitted.length, 0)
})

test('새 드래그를 시작하면 이전 드래그의 이벤트 처리는 끝난다', () => {
  const { drag, emitted } = setup()
  drag.startMoveDrag(asPointer(pointer('pointerdown', [0, 0])))
  drag.startMoveDrag(asPointer(pointer('pointerdown', [100, 100])))
  move([110, 100])
  assert.equal(emitted.filter((item) => item.name === 'transformBy').length, 1, '한 번만 처리한다')
  const fn = emitted[1].args[0] as (x: number, y: number) => Pt
  assert.deepEqual(fn(0, 0), [10, 0], '두 번째 시작점 기준')
})

test('핸들 드래그(크기): 이벤트 전파를 막고 변환과 배율을 전달한다', () => {
  const { drag, emitted } = setup()
  const down = pointer('pointerdown', [500, 230])
  drag.startHandleDrag('e', asPointer(down))
  assert.equal(down.cancelBubble, true, 'stopPropagation을 호출했다')
  move([700, 230])
  const [restore, transform] = emitted
  assert.equal(restore.name, 'restoreSnapshot')
  const fn = transform.args[0] as (x: number, y: number) => Pt
  assert.deepEqual(fn(500, 230), [700, 230])
  assert.deepEqual(fn(100, 230), [100, 230])
  assert.equal(transform.args[1], 1.25)
})

test('핸들 드래그: Shift 상태는 움직일 때마다 읽는다(회전은 15도 단위)', () => {
  const { drag, emitted } = setup({ mode: 'rotate' })
  drag.startHandleDrag('ne', asPointer(pointer('pointerdown', [500, 360])))
  move([300, 600], { shiftKey: true })
  const fn = emitted[1].args[0] as (x: number, y: number) => Pt
  const [x, y] = fn(500, 230)
  assert.ok(Number.isFinite(x) && Number.isFinite(y))
  assert.equal(emitted[1].args[1], 1)
})

test('핸들 드래그: 잠김·영역 없음이면 시작하지 않지만 전파는 막는다', () => {
  const { drag, emitted } = setup({ locked: true })
  const down = pointer('pointerdown', [500, 230])
  drag.startHandleDrag('e', asPointer(down))
  move([700, 230])
  assert.equal(down.cancelBubble, true)
  assert.equal(emitted.length, 0)
})

test('베지어 핸들 드래그: 시작 경로를 기준으로 움직인 경로를 전달한다', () => {
  const { drag, emitted } = setup({ bezier: 'M 0 0 L 10 0 L 10 10 L 0 0 Z' })
  drag.startBezierHandleDrag({ kind: 'anchor', segIndex: 1 }, asPointer(pointer('pointerdown', [10, 0])))
  move([20, 5])
  assert.equal(emitted[0].name, 'updatePath')
  assert.deepEqual(emitted[0].args, [1, 'M 0 0 L 20 5 L 10 10 L 0 0 Z'])
  move([30, 7]) // 매번 시작 경로에서 계산한다
  assert.deepEqual(emitted[1].args, [1, 'M 0 0 L 30 7 L 10 10 L 0 0 Z'])
})

test('베지어 핸들 드래그: 대상 경로가 없거나 잠기면 시작하지 않는다', () => {
  const none = setup({ bezier: null })
  none.drag.startBezierHandleDrag({ kind: 'anchor', segIndex: 1 }, asPointer(pointer('pointerdown', [0, 0])))
  move([1, 1])
  assert.equal(none.emitted.length, 0)
  const locked = setup({ bezier: 'M 0 0 L 1 1 Z', locked: true })
  locked.drag.startBezierHandleDrag({ kind: 'anchor', segIndex: 1 }, asPointer(pointer('pointerdown', [0, 0])))
  move([1, 1])
  assert.equal(locked.emitted.length, 0)
})

test('중심선 정점: 끌면 이동, Alt를 누르면 삭제, 잠기면 무시', () => {
  const { drag, emitted } = setup()
  drag.onMedianVertexPointerDown(2, asPointer(pointer('pointerdown', [0, 0])))
  move([40, 50])
  assert.deepEqual(emitted[0], { name: 'moveMedianVertex', args: [1, 2, [40, 50]] })
  release()
  drag.onMedianVertexPointerDown(3, asPointer(pointer('pointerdown', [0, 0], { altKey: true })))
  assert.deepEqual(emitted[1], { name: 'deleteMedianVertex', args: [1, 3] })
  move([1, 1])
  assert.equal(emitted.length, 2, 'Alt 삭제는 드래그를 시작하지 않는다')
  const locked = setup({ locked: true })
  locked.drag.onMedianVertexPointerDown(0, asPointer(pointer('pointerdown', [0, 0])))
  move([1, 1])
  assert.equal(locked.emitted.length, 0)
})

test('중심선 위를 누르면 그 위치에 정점을 추가한다', () => {
  const { drag, emitted } = setup()
  drag.onMedianLinePointerDown(asPointer(pointer('pointerdown', [123, 45])))
  assert.deepEqual(emitted[0], { name: 'addMedianVertex', args: [1, [123, 45]] })
  drag.onMedianLinePointerDown(asPointer(pointer('pointerdown', null)))
  assert.equal(emitted.length, 1, '위치가 없으면 추가하지 않는다')
  const locked = setup({ locked: true })
  locked.drag.onMedianLinePointerDown(asPointer(pointer('pointerdown', [1, 1])))
  assert.equal(locked.emitted.length, 0)
})
