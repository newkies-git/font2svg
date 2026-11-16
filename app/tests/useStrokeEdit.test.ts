import assert from 'node:assert/strict'
import test from 'node:test'
import { ref } from 'vue'
import { createLayerEditorState } from '../src/composables/layerEditorState.ts'
import { useStrokeEdit } from '../src/composables/useStrokeEdit.ts'
import { LAYER_ID } from '../shared/constants.ts'
import type { LayerRecord, StrokeRecord } from '../shared/types.ts'
import { rectPath, strokeOf } from './helpers.ts'

const bar = (y: number): StrokeRecord => strokeOf(rectPath(100, y, 500, y + 60), [[110, y + 30], [490, y + 30]])

function layerOf(id: string, kind: LayerRecord['kind'], strokes: StrokeRecord[], overrides: Partial<LayerRecord> = {}): LayerRecord {
  return { id, kind, name: id, z_index: 0, visible: true, opacity: 1, locked: false, label_color: 'none', available: true, modified: false, source_url: null, strokes, paths: [], ...overrides }
}

// 실제 화면 상태와 같은 구성에서, 잠금·숨김이면 편집 대상을 주지 않는 가드로 편집 컴포저블을 만든다.
function setup(strokes: StrokeRecord[], overrides: Partial<LayerRecord> = {}) {
  const state = createLayerEditorState(ref(null), ref(0), ref(1))
  state.layers.value = [layerOf(LAYER_ID.strokes, 'STROKES', strokes, overrides)]
  state.activeLayerId.value = LAYER_ID.strokes
  const message = ref('')
  const error = ref('')
  const dirty: string[] = []
  const guardUnlocked = () => (state.isEditableLocked.value ? null : state.editableLayer.value)
  const edit = useStrokeEdit(state, message, error, guardUnlocked, (id) => { dirty.push(id) })
  return { state, edit, message, error, dirty, work: () => state.layers.value[0] }
}

test('획 이동: 순서가 바뀌고 번호가 다시 매겨지며 dirty로 표시된다', () => {
  const { edit, work, dirty, state } = setup([bar(100), bar(300), bar(500)])
  edit.moveStrokeInActive(0, 1)
  assert.deepEqual(work().strokes.map((s) => s.outline_path), [bar(300), bar(100), bar(500)].map((s) => s.outline_path))
  assert.deepEqual(work().strokes.map((s) => s.stroke_order), [1, 2, 3])
  assert.equal(state.selectedStrokeIndex.value, 1)
  assert.deepEqual(dirty, [LAYER_ID.strokes])
  edit.moveStrokeInActive(2, 1)
  assert.equal(dirty.length, 1, '범위를 벗어난 이동은 아무것도 바꾸지 않는다')
})

test('잠긴 레이어는 어떤 편집도 받지 않는다', () => {
  const { edit, work, dirty } = setup([bar(100), bar(300)], { locked: true })
  edit.moveStrokeInActive(0, 1)
  edit.deleteStrokeAt(0)
  edit.reverseActiveStrokeMedian(0)
  edit.addMedianVertex(0, [300, 130])
  assert.equal(work().strokes.length, 2)
  assert.deepEqual(work().strokes[0].median_points, bar(100).median_points)
  assert.equal(dirty.length, 0)
})

test('획 삭제: 마지막 한 획은 지울 수 없다', () => {
  const { edit, work, error } = setup([bar(100), bar(300)])
  edit.deleteStrokeAt(0)
  assert.equal(work().strokes.length, 1)
  edit.deleteStrokeAt(0)
  assert.equal(work().strokes.length, 1)
  assert.match(error.value, /최소 1개/)
})

test('기필↔수필 반전은 원본 객체를 건드리지 않고 새 획으로 바꾼다', () => {
  const original = bar(100)
  const { edit, work } = setup([original])
  edit.reverseActiveStrokeMedian(0)
  assert.deepEqual(work().strokes[0].median_points, [[490, 130], [110, 130]])
  assert.deepEqual(original.median_points, [[110, 130], [490, 130]])
})

test('중심선 정점: 추가·이동·삭제와 최소 2점 보호', () => {
  const { edit, work, error, state } = setup([bar(100)])
  edit.addMedianVertex(0, [300, 130])
  assert.equal(work().strokes[0].median_points.length, 3)
  assert.notEqual(state.selectedMedianPointIndex.value, null)
  edit.moveMedianVertex(0, 1, [300.04, 131.26])
  assert.deepEqual(work().strokes[0].median_points[1], [300, 131.3])
  edit.deleteMedianVertex(0, 1)
  assert.equal(work().strokes[0].median_points.length, 2)
  assert.equal(state.selectedMedianPointIndex.value, null)
  edit.deleteMedianVertex(0, 0)
  assert.equal(work().strokes[0].median_points.length, 2)
  assert.match(error.value, /최소 2개/)
})

test('다음 획과 병합하면 한 획이 되고 선택이 유지된다', () => {
  const { edit, work, state } = setup([bar(100), bar(300), bar(500)])
  edit.mergeStrokeWithNext(0)
  assert.equal(work().strokes.length, 2)
  assert.equal(state.selectedStrokeIndex.value, 0)
  edit.mergeStrokeWithNext(1)
  assert.equal(work().strokes.length, 2, '마지막 획은 병합할 다음 획이 없다')
})

test('칼 분할: 두 점으로 획을 둘로 가르고 조각이 선택된다', () => {
  const { edit, work, state } = setup([bar(100)])
  edit.applyKnifePoint([300, 50])
  assert.deepEqual(state.knifeFrom.value, [300, 50])
  edit.applyKnifePoint([300, 200])
  assert.equal(state.knifeFrom.value, null)
  assert.equal(work().strokes.length, 2)
  assert.equal(state.selectedStrokeIndex.value, 1)
})

test('윤곽 연결: 3점 미만이면 오류, 3점이면 선택 획의 윤곽을 바꾼다', () => {
  const { edit, work, error } = setup([bar(100)])
  edit.applyConnectPoint([100, 100])
  edit.applyConnectPoint([100.5, 100.5])
  assert.equal(error.value, '')
  edit.commitConnectOutline()
  assert.match(error.value, /최소 3점/)
  edit.applyConnectPoint([500, 100])
  edit.applyConnectPoint([500, 400])
  edit.commitConnectOutline()
  assert.match(work().strokes[0].outline_path, /^M 100 100 L 500 100 L 500 400 Z$/)
})

test('작업 획에 추가: 다른 레이어의 획을 복제해 끝에 붙인다', () => {
  const { state, edit } = setup([bar(100)])
  state.layers.value.push(layerOf(LAYER_ID.naver, 'NAVER', [bar(300), bar(500)]))
  state.activeLayerId.value = LAYER_ID.naver
  edit.copyStrokeToWorkLayer(1)
  const work = state.layers.value[0]
  assert.equal(work.strokes.length, 2)
  assert.equal(work.strokes[1].outline_path, bar(500).outline_path)
  assert.notEqual(work.strokes[1], state.layers.value[1].strokes[1], '복제본이어야 한다')
  assert.deepEqual(work.strokes.map((s) => s.stroke_order), [1, 2])
})

test('전체 맞춤 정렬: 궁서체 윤곽 영역으로 획을 옮긴다', () => {
  const { state, edit, work } = setup([bar(100)])
  state.layers.value.push(layerOf(LAYER_ID.font, 'FONT', [], { paths: [rectPath(0, 0, 200, 100)] }))
  edit.alignActiveToFont()
  const xs = work().strokes[0].median_points.map((p) => p[0])
  assert.ok(Math.min(...xs) >= 0 && Math.max(...xs) <= 200)
})
