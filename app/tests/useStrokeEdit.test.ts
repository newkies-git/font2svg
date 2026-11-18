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
  assert.deepEqual(state.knifePoints.value, [[300, 50]])
  edit.applyKnifePoint([300, 200])
  assert.deepEqual(state.knifePoints.value, [])
  assert.equal(work().strokes.length, 2)
  assert.equal(state.selectedStrokeIndex.value, 1)
})

// 가로 획 bar(y)를 가로지르는 세로 칼: 획 하나를 둘로 가른다.
const cutBar = (edit: ReturnType<typeof setup>['edit'], y: number) => {
  edit.applyKnifePoint([300, y - 50])
  edit.applyKnifePoint([300, y + 110])
}

test('칼 분할: 전체가 보이던 상태에서 앞쪽 획을 가르면 나머지 획도 계속 보인다', () => {
  const { edit, work, state } = setup([bar(100), bar(300), bar(500)])
  state.shown.value = 3
  state.selectedStrokeIndex.value = 0
  cutBar(edit, 100)
  assert.equal(work().strokes.length, 4)
  assert.equal(state.shown.value, 4, '3획 → 4획 모두 보인다(예전에는 2획까지만 보였다)')
  assert.equal(state.selectedStrokeIndex.value, 1)
})

test('칼 분할: 중간 단계까지 보던 중 보이는 획을 가르면 뒤의 보이던 획만 따라 늘어난다', () => {
  const { edit, work, state } = setup([bar(100), bar(300), bar(500)])
  state.shown.value = 2
  state.selectedStrokeIndex.value = 1
  cutBar(edit, 300)
  assert.equal(work().strokes.length, 4)
  assert.equal(state.shown.value, 3, '보이던 2획 중 2번째를 나눠 3획까지 보이고, 3번째 원래 획(4번째)은 계속 숨는다')
})

test('칼 분할: 아직 보이지 않던 획을 가르면 그 조각까지 보이게 한다', () => {
  const { edit, work, state } = setup([bar(100), bar(300), bar(500)])
  state.shown.value = 1
  state.selectedStrokeIndex.value = 2
  cutBar(edit, 500)
  assert.equal(work().strokes.length, 4)
  assert.equal(state.shown.value, 4, '2·3번째 획과 새 조각 둘이 모두 보인다')
})

test('칼 분할: 보이는 획 수는 전체 획 수를 넘지 않는다', () => {
  const { edit, work, state } = setup([bar(100)])
  state.shown.value = 1
  state.selectedStrokeIndex.value = 0
  cutBar(edit, 100)
  assert.equal(work().strokes.length, 2)
  assert.equal(state.shown.value, 2)
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

test('궁서체 레이어는 위치·크기 변환·맞춤 대상이 되지 않는다', () => {
  const path = rect(100, 100, 400, 400)
  const { edit, font, error, dirty } = setupLayers([path], [bar(100)], LAYER_ID.font)
  edit.applyAffineToActive((x, y) => [x + 50, y + 50], 1)
  assert.deepEqual(font().paths, [path])
  assert.match(error.value, /기준 레이어/)
  assert.equal(dirty.length, 0)
  edit.autoFitToFont()
  assert.deepEqual(font().paths, [path])
})

// 궁서체(윤곽만 있는 레이어)와 작업 획을 함께 둔 편집 환경. active로 편집 대상을 고른다.
function setupLayers(fontPaths: string[], strokes: StrokeRecord[], active: string, options: { fontLocked?: boolean } = {}) {
  const state = createLayerEditorState(ref(null), ref(0), ref(1))
  state.layers.value = [
    layerOf(LAYER_ID.font, 'FONT', [], { paths: fontPaths, locked: options.fontLocked ?? false }),
    { ...layerOf(LAYER_ID.strokes, 'STROKES', strokes), z_index: 1 },
  ]
  state.activeLayerId.value = active
  const message = ref('')
  const error = ref('')
  const dirty: string[] = []
  const guardUnlocked = () => (state.isEditableLocked.value ? null : state.editableLayer.value)
  const edit = useStrokeEdit(state, message, error, guardUnlocked, (id) => { dirty.push(id) })
  const font = () => state.layers.value[0]
  const work = () => state.layers.value[1]
  return { state, edit, message, error, dirty, font, work }
}

const rect = (x0: number, y0: number, x1: number, y1: number) => rectPath(x0, y0, x1, y1)

test('윤곽 레이어: 윤곽 순서 이동과 삭제(마지막 하나는 보호)', () => {
  const { edit, font, state, error } = setupLayers([rect(0, 0, 10, 10), rect(20, 0, 30, 10), rect(40, 0, 50, 10)], [], LAYER_ID.font)
  edit.moveStrokeInActive(0, 2)
  assert.deepEqual(font().paths.map((d) => d.split(' ')[1]), ['20', '40', '0'])
  assert.equal(state.selectedStrokeIndex.value, 2)
  edit.moveStrokeInActive(0, -1) // 범위 밖은 무시
  assert.equal(font().paths.length, 3)
  edit.deleteStrokeAt(0)
  edit.deleteStrokeAt(0)
  assert.equal(font().paths.length, 1)
  edit.deleteStrokeAt(0)
  assert.equal(font().paths.length, 1)
  assert.match(error.value, /마지막 남은 윤곽/)
})

test('궁서체 윤곽은 변환 범위와 무관하게 위치·크기를 바꾸지 않는다', () => {
  const paths = [rect(0, 0, 10, 10), rect(20, 0, 30, 10)]
  const { edit, font, state, error } = setupLayers(paths, [], LAYER_ID.font)
  const shift = (x: number, y: number): [number, number] => [x + 5, y]
  state.transformScope.value = 'stroke'
  state.selectedStrokeIndex.value = 1
  edit.applyAffineToActive(shift)
  assert.deepEqual(font().paths, paths)
  state.transformScope.value = 'layer'
  edit.applyAffineToActive(shift)
  assert.deepEqual(font().paths, paths)
  assert.match(error.value, /기준 레이어/)
})

test('획 변환: 단일 획 범위와 레이어 전체 범위', () => {
  const { edit, work, state } = setupLayers([], [bar(100), bar(300)], LAYER_ID.strokes)
  const down = (x: number, y: number): [number, number] => [x, y - 10]
  state.transformScope.value = 'stroke'
  state.selectedStrokeIndex.value = 1
  edit.applyAffineToActive(down)
  assert.equal(work().strokes[0].median_points[0][1], 130)
  assert.equal(work().strokes[1].median_points[0][1], 320)
  state.transformScope.value = 'layer'
  edit.applyAffineToActive(down)
  assert.equal(work().strokes[0].median_points[0][1], 120)
})

test('윤곽 하나의 베지어 편집 결과를 반영한다(획이면 폭도 다시 계산)', () => {
  const contour = setupLayers([rect(0, 0, 10, 10)], [], LAYER_ID.font)
  contour.edit.updateSinglePathInActive(0, rect(0, 0, 20, 20))
  contour.edit.updateSinglePathInActive(5, rect(1, 1, 2, 2)) // 없는 윤곽 번호는 무시
  assert.deepEqual(contour.font().paths, [rect(0, 0, 20, 20)])
  const stroked = setupLayers([], [bar(100)], LAYER_ID.strokes)
  stroked.edit.updateSinglePathInActive(0, rect(100, 100, 500, 220))
  assert.equal(stroked.work().strokes[0].outline_path, rect(100, 100, 500, 220))
  assert.notEqual(stroked.work().strokes[0].stroke_width, bar(100).stroke_width, '새 윤곽에 맞춰 폭이 바뀐다')
  stroked.edit.updateSinglePathInActive(9, rect(0, 0, 1, 1))
  assert.equal(stroked.work().strokes.length, 1)
})

test('부수·캡 설정은 해당 획만 바꾸고 dirty로 표시한다', () => {
  const { edit, work, dirty } = setupLayers([], [bar(100), bar(300)], LAYER_ID.strokes)
  edit.setStrokeRadical(1, 1)
  edit.setStrokeCap(0, 'start', 'AUTO_ROUND')
  edit.setStrokeCap(0, 'end', 'REF_STAMP')
  edit.setStrokeRadical(9, 1) // 없는 획은 무시
  assert.deepEqual(work().strokes.map((s) => s.is_radical), [0, 1])
  assert.equal(work().strokes[0].start_cap_type, 'AUTO_ROUND')
  assert.equal(work().strokes[0].end_cap_type, 'REF_STAMP')
  assert.equal(dirty.length, 3)
})

test('스냅샷 복원: 편집 가능할 때만 되돌린다', () => {
  const { edit, work, state } = setupLayers([], [bar(100)], LAYER_ID.strokes)
  edit.restoreActiveSnapshot([bar(300), bar(500)], ['M 0 0 Z'])
  assert.equal(work().strokes.length, 2)
  assert.deepEqual(work().paths, ['M 0 0 Z'])
  state.layers.value[1].locked = true
  edit.restoreActiveSnapshot([], [])
  assert.equal(work().strokes.length, 2, '잠기면 복원하지 않는다')
})

test('칼 분할(윤곽 레이어): 윤곽을 둘로 가르고, 교차하지 않으면 오류', () => {
  const { edit, font } = setupLayers([rect(0, 0, 400, 100)], [], LAYER_ID.font)
  edit.applyKnifePoint([200, -20])
  edit.applyKnifePoint([200, 120])
  assert.equal(font().paths.length, 2)
  const miss = setupLayers([rect(0, 0, 400, 100)], [], LAYER_ID.font)
  miss.edit.applyKnifePoint([900, 0])
  miss.edit.applyKnifePoint([900, 1000])
  assert.equal(miss.font().paths.length, 1)
  assert.match(miss.error.value, /윤곽 분할 불가/)
})

test('칼 분할(획): 교차하지 않으면 오류, Esc 취소는 시작점을 지운다', () => {
  const { edit, work, error, state, message } = setupLayers([], [bar(100)], LAYER_ID.strokes)
  edit.applyKnifePoint([900, 0])
  edit.cancelKnife()
  assert.deepEqual(state.knifePoints.value, [])
  assert.equal(message.value, '획 분할이 취소되었습니다.')
  edit.applyKnifePoint([900, 0])
  edit.applyKnifePoint([900, 500])
  assert.equal(work().strokes.length, 1)
  assert.match(error.value, /획 분할 불가/)
  edit.applyKnifePoint([300, 90])
  edit.applyKnifePoint([300.5, 90.5]) // 4 미만의 짧은 칼은 자를 수 없다
  assert.equal(work().strokes.length, 1)
})

test('칼 분할(획 윤곽 OUTLINE 레이어): 가른 조각은 수동 매핑으로 표시한다', () => {
  const state = createLayerEditorState(ref(null), ref(0), ref(1))
  state.layers.value = [layerOf(LAYER_ID.outline, 'OUTLINE', [strokeOf(rect(100, 100, 500, 160), [[110, 130], [490, 130]])])]
  state.activeLayerId.value = LAYER_ID.outline
  const guard = () => (state.isEditableLocked.value ? null : state.editableLayer.value)
  const edit = useStrokeEdit(state, ref(''), ref(''), guard, () => {})
  edit.applyKnifePoint([300, 50])
  edit.applyKnifePoint([300, 200])
  const strokes = state.layers.value[0].strokes
  assert.equal(strokes.length, 2)
  assert.ok(strokes.every((stroke) => stroke.map_manual === 1))
})

test('윤곽 연결 도구: 점 지정·되돌리기·취소와 안내 메시지', () => {
  const { edit, state, message } = setupLayers([rect(0, 0, 10, 10)], [], LAYER_ID.font)
  edit.undoConnectPoint() // 점이 없으면 아무 일도 없다
  edit.cancelConnect()
  assert.equal(message.value, '')
  edit.applyConnectPoint([0, 0])
  assert.equal(message.value, '윤곽 연결: 중간점 또는 끝점을 클릭하세요.')
  edit.applyConnectPoint([10, 0])
  assert.match(message.value, /끝점\(또는 추가 중간점\)/)
  edit.applyConnectPoint([10, 10])
  assert.match(message.value, /3점 지정됨/)
  edit.applyConnectPoint([10.5, 10.5]) // 1.5 미만 거리의 중복 점은 무시
  assert.equal(state.connectPoints.value.length, 3)
  edit.undoConnectPoint()
  assert.equal(state.connectPoints.value.length, 2)
  assert.match(message.value, /2점 지정됨/)
  edit.cancelConnect()
  assert.deepEqual(state.connectPoints.value, [])
  assert.equal(message.value, '윤곽 연결이 취소되었습니다.')
  edit.undoConnectPoint()
})

test('윤곽 연결(윤곽 레이어): 지정한 점으로 선택한 윤곽을 다시 만든다', () => {
  const { edit, font } = setupLayers([rect(0, 0, 10, 10)], [], LAYER_ID.font)
  for (const point of [[0, 0], [30, 0], [30, 30]] as [number, number][]) edit.applyConnectPoint(point)
  edit.commitConnectOutline()
  assert.deepEqual(font().paths, ['M 0 0 L 30 0 L 30 30 Z'])
})

test('잠긴 윤곽 레이어에서는 연결·칼 점 지정이 무시된다', () => {
  const { edit, state } = setupLayers([rect(0, 0, 10, 10)], [], LAYER_ID.font, { fontLocked: true })
  edit.applyConnectPoint([1, 1])
  edit.applyKnifePoint([1, 1])
  assert.deepEqual(state.connectPoints.value, [])
  assert.deepEqual(state.knifePoints.value, [])
})

test('자동 맞춤: 기준 윤곽·획이 없으면 오류', () => {
  const noFont = setupLayers([], [bar(100)], LAYER_ID.strokes)
  noFont.edit.autoFitToFont()
  assert.match(noFont.error.value, /맞춤 기준이 될 궁서체/)
  const noStrokes = setupLayers([rect(0, 0, 10, 10)], [], LAYER_ID.strokes)
  noStrokes.edit.autoFitToFont()
  assert.match(noStrokes.error.value, /자동으로 맞출 획 데이터가 없습니다/)
})

test('자동 맞춤: 어긋난 획을 궁서체에 겹치게 옮기고 개선 비율을 알린다', () => {
  const target = rect(100, 300, 900, 400)
  const shifted = strokeOf(rect(100, 380, 900, 480), [[110, 430], [890, 430]], { stroke_width: 100 })
  const { edit, work, message, dirty } = setupLayers([target], [shifted], LAYER_ID.strokes)
  edit.autoFitToFont()
  assert.match(message.value, /자동 맞춤: 궁서체 겹침 \d+% → \d+%/)
  assert.ok(work().strokes[0].median_points[0][1] < 430, '아래로 옮겨졌다')
  assert.equal(dirty.length, 1)
})

test('자동 맞춤: 이미 겹치면 더 나은 위치를 못 찾았다고 알리고 바꾸지 않는다', () => {
  const target = rect(100, 300, 900, 400)
  const exact = strokeOf(target, [[110, 350], [890, 350]], { stroke_width: 100 })
  const { edit, work, message, dirty } = setupLayers([target], [exact], LAYER_ID.strokes)
  edit.autoFitToFont()
  assert.match(message.value, /더 나은 위치를 찾지 못했습니다/)
  assert.equal(work().strokes[0].outline_path, target)
  assert.equal(dirty.length, 0)
})

test('자동 맞춤: 단일 획 범위면 선택한 획만 맞춘다', () => {
  const target = rect(100, 300, 900, 400)
  const shifted = strokeOf(rect(100, 380, 900, 480), [[110, 430], [890, 430]], { stroke_width: 100 })
  const { edit, work, message, state } = setupLayers([target], [bar(700), shifted], LAYER_ID.strokes)
  state.transformScope.value = 'stroke'
  state.selectedStrokeIndex.value = 1
  const untouched = work().strokes[0].median_points[0][1]
  edit.autoFitToFont()
  assert.match(message.value, /^2획 자동 맞춤/)
  assert.equal(work().strokes[0].median_points[0][1], untouched)
})

test('기필·수필 모양: 모양을 고르면 그 끝의 윤곽이 바뀌고, 기본으로 돌아오면 복원하며, 도장·직접 그리기는 값만 기록한다', () => {
  const { edit, work, error } = setup([bar(100)])
  const original = work().strokes[0].outline_path
  edit.setStrokeCap(0, 'start', 'AUTO_ROUND')
  const rounded = work().strokes[0].outline_path
  assert.notEqual(rounded, original)
  assert.equal(work().strokes[0].start_cap_type, 'AUTO_ROUND')
  edit.setStrokeCap(0, 'start', 'POINTED')
  assert.notEqual(work().strokes[0].outline_path, rounded, '다른 모양으로 바꾸면 윤곽이 다시 그려진다')
  edit.setStrokeCap(0, 'start', 'NONE')
  assert.equal(work().strokes[0].start_cap_type, 'NONE')
  const restored = work().strokes[0].outline_path
  edit.setStrokeCap(0, 'end', 'REF_STAMP')
  edit.setStrokeCap(0, 'end', 'MANUAL')
  assert.equal(work().strokes[0].outline_path, restored, '도장·직접 그리기는 윤곽을 바꾸지 않는다')
  assert.equal(work().strokes[0].end_cap_type, 'MANUAL')
  assert.equal(error.value, '')
})

test('기필·수필 모양: 적용할 수 없는 획은 값도 윤곽도 바꾸지 않고 오류를 알린다', () => {
  const broken = strokeOf('M 0 0 Z', [[0, 0], [1, 1]])
  const { edit, work, error } = setup([broken])
  edit.setStrokeCap(0, 'start', 'AUTO_ROUND')
  assert.equal(work().strokes[0].start_cap_type, 'NONE')
  assert.equal(work().strokes[0].outline_path, 'M 0 0 Z')
  assert.match(error.value, /모양을 적용할 수 없습니다/)
})

test('칼 분할(획): 한쪽에서 떨어진 덩어리가 여럿이면 모두 획이 되고 선택은 두 번째 조각으로 간다', () => {
  // 가로 획 둘과 그 사이의 다리 둘(ㅍ의 아래쪽): 아래 가로 획의 윗변(y=260)을 따라 자르면 가로 획과 다리 둘이 나온다
  const legs = 'M200 540 L800 540 L800 460 L680 460 L680 20 L600 20 L600 460 L400 460 L400 20 L320 20 L320 460 L200 460 Z'
  const { edit, work, state } = setup([strokeOf(legs, [[0, 0], [1, 1]], { stroke_width: 135 })])
  edit.applyKnifePoint([0, 460])
  edit.applyKnifePoint([1000, 460])
  assert.equal(work().strokes.length, 3, '가로 획과 다리 둘')
  assert.deepEqual(work().strokes.map((stroke) => stroke.stroke_order), [1, 2, 3])
  assert.equal(state.selectedStrokeIndex.value, 1)
})

test('칼 분할(획): Shift+클릭으로 꺾는 점을 더하면 꺾인 칼로 ㄱ을 한 번에 가른다', () => {
  const giyeok = 'M200 800 L800 800 L800 200 L720 200 L720 720 L540 720 L540 400 L460 400 L460 720 L200 720 Z'
  const { edit, work, state } = setup([strokeOf(giyeok, [[0, 0], [1, 1]], { stroke_width: 135 })])
  edit.applyKnifePoint([0, 720])
  edit.applyKnifePoint([720, 720], true)
  assert.deepEqual(state.knifePoints.value, [[0, 720], [720, 720]], '꺾는 점을 더해도 아직 자르지 않는다')
  assert.equal(work().strokes.length, 1)
  edit.applyKnifePoint([720, 0])
  assert.deepEqual(state.knifePoints.value, [])
  assert.equal(work().strokes.length, 2, 'ㄱ과 매달린 세로')
})

test('교차 분리 모드: 안내선을 따라 十를 ―와 ㅣ 두 획으로 나누고 교차부는 둘 다 가진다', () => {
  const cross = 'M460 800 L540 800 L540 540 L800 540 L800 460 L540 460 L540 200 L460 200 L460 460 L200 460 L200 540 L460 540 Z'
  const { edit, work, state, message } = setup([strokeOf(cross, [[0, 0], [1, 1]], { stroke_width: 80 })])
  state.knifeMode.value = 'extract'
  edit.applyKnifePoint([200, 500])
  edit.applyKnifePoint([800, 500])
  assert.equal(work().strokes.length, 2, '―와 ㅣ')
  assert.deepEqual(state.knifePoints.value, [])
  assert.match(message.value, /교차 분리/)
})

test('윤곽 연결 도구: 바로 앞 점과 거의 같은 곳을 다시 찍으면 점을 더하지 않는다', () => {
  const { edit, state } = setup([bar(100)])
  const FAR = 50
  const NEAR = 1
  edit.applyConnectPoint([100, 100])
  edit.applyConnectPoint([100 + NEAR, 100])
  assert.equal(state.connectPoints.value.length, 1, '1 이하로 떨어진 점은 같은 점으로 본다')
  edit.applyConnectPoint([100 + FAR, 100])
  assert.equal(state.connectPoints.value.length, 2)
})
