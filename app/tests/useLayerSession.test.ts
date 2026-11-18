import assert from 'node:assert/strict'
import test from 'node:test'
import { LAYER_ID } from '../shared/constants.ts'
import { bar, detailOf, layerOf, setupWorkspace } from './studioHarness.ts'

const work = (...strokes: ReturnType<typeof bar>[]) => layerOf(LAYER_ID.strokes, 'STROKES', { name: '작업 획', strokes })
const fontLayer = (paths: string[] = ['M 0 0 Z', 'M 1 1 Z']) => layerOf(LAYER_ID.font, 'FONT', { name: '궁서체', paths })
const medians = () => layerOf(LAYER_ID.medians, 'MEDIANS', { name: '중심선' })

test('서버 상세를 반영하면 dirty·단독 보기·진행 중 도구 상태를 초기화한다', () => {
  const { workspace } = setupWorkspace([fontLayer(), work(bar(100), bar(300))])
  workspace.dirtyIds.value = new Set([LAYER_ID.strokes])
  workspace.knifePoints.value = [[1, 2]]
  workspace.connectPoints.value = [[1, 1]]
  workspace.selectedMedianPointIndex.value = 3
  workspace.syncFromDetail(detailOf([fontLayer(), work(bar(100), bar(300))]))
  assert.equal(workspace.dirtyIds.value.size, 0)
  assert.deepEqual(workspace.knifePoints.value, [])
  assert.deepEqual(workspace.connectPoints.value, [])
  assert.equal(workspace.selectedMedianPointIndex.value, null)
})

test('서버 상세를 반영: 재생 위치는 전체 획수, 선택은 범위 안으로 맞춘다', () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work(bar(100), bar(300), bar(500))])
  workspace.selectedStrokeIndex.value = 2
  workspace.syncFromDetail(detailOf([fontLayer(), work(bar(100))]))
  assert.equal(studio.shown.value, 1)
  assert.equal(studio.reveal.value, 1)
  assert.equal(workspace.selectedStrokeIndex.value, 0)
})

test('선택한 레이어가 응답에 없으면 작업 획 레이어로 돌아간다', () => {
  const { workspace } = setupWorkspace([fontLayer(), layerOf('c1', 'CUSTOM'), work(bar(100))])
  workspace.activeLayerId.value = 'c1'
  workspace.syncFromDetail(detailOf([fontLayer(), work(bar(100))]))
  assert.equal(workspace.activeLayerId.value, LAYER_ID.strokes)
})

test('작업 획 레이어가 dirty가 되면 선택된 글자의 획도 즉시 맞춘다', () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work(bar(100))])
  workspace.layers.value.find((layer) => layer.id === LAYER_ID.strokes)!.strokes = [bar(100), bar(300)]
  assert.equal(studio.selected.value!.strokes.length, 1)
  // 편집 컴포저블이 쓰는 경로: 획을 지우고 되돌리는 대신 이동으로 dirty를 만든다.
  workspace.moveStrokeInActive(0, 1)
  assert.equal(workspace.dirtyIds.value.has(LAYER_ID.strokes), true)
  assert.equal(studio.selected.value!.strokes.length, 2)
})

test('도구 선택: 칼·연결 진행 상태를 지우고 연결 도구면 안내를 보인다', () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work(bar(100))])
  workspace.knifePoints.value = [[1, 2]]
  workspace.connectPoints.value = [[1, 1]]
  workspace.selectTool('connect')
  assert.equal(workspace.activeTool.value, 'connect')
  assert.deepEqual(workspace.knifePoints.value, [])
  assert.deepEqual(workspace.connectPoints.value, [])
  assert.match(studio.message.value, /윤곽 연결: 시작점/)
  studio.message.value = ''
  workspace.selectTool('select')
  assert.equal(studio.message.value, '')
})

test('중심선 레이어를 고르면 중심선 도구로 바뀌고 편집 대상은 작업 획이다', () => {
  const { workspace } = setupWorkspace([fontLayer(), work(bar(100)), medians()])
  workspace.selectLayer(LAYER_ID.medians)
  assert.equal(workspace.activeTool.value, 'median')
  assert.equal(workspace.editableLayer.value!.id, LAYER_ID.strokes)
})

test('레이어 선택: 선택한 획 번호를 새 레이어의 범위 안으로 줄이고 재생 위치를 맞춘다', () => {
  const { workspace, studio } = setupWorkspace([fontLayer(['M 0 0 Z']), work(bar(100), bar(300), bar(500))])
  workspace.selectedStrokeIndex.value = 2
  workspace.selectLayer(LAYER_ID.font) // 윤곽 1개
  assert.equal(workspace.selectedStrokeIndex.value, 0)
  studio.shown.value = 0
  workspace.selectLayer(LAYER_ID.strokes)
  assert.equal(studio.shown.value, 3, '재생 위치가 0이면 전체 획수로 맞춘다')
})

test('획 항목 선택: 재생을 멈추고, 작업 획이면 그 획까지만 보여 준다', () => {
  const { workspace, studio, stopped } = setupWorkspace([fontLayer(), work(bar(100), bar(300), bar(500))])
  studio.reveal.value = 0.4
  workspace.selectStrokeItem(1)
  assert.equal(stopped.count, 1)
  assert.equal(workspace.selectedStrokeIndex.value, 1)
  assert.equal(studio.shown.value, 2)
  assert.equal(studio.reveal.value, 1)
  workspace.selectLayer(LAYER_ID.font)
  studio.shown.value = 3
  workspace.selectStrokeItem(0)
  assert.equal(studio.shown.value, 3, '작업 획이 아닌 레이어는 재생 위치를 바꾸지 않는다')
})

test('잠금 가드: 잠금·숨김이면 이유를 알리고, 풀리면 오류를 지우고 대상을 준다', () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work(bar(100))])
  const target = workspace.layers.value.find((layer) => layer.id === LAYER_ID.strokes)!
  target.locked = true
  workspace.moveStrokeInActive(0, 1)
  assert.match(studio.error.value, /'작업 획' 레이어가 잠겨 있거나 숨겨져 있습니다/)
  target.locked = false
  workspace.moveStrokeInActive(0, 1) // 이동할 곳이 없어도 가드는 통과해 오류를 지운다
  assert.equal(studio.error.value, '')
})

test('초기화: 미저장 편집을 불러온 상태로 되돌리고 dirty를 지운다', () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work(bar(100), bar(300))])
  workspace.syncFromDetail(detailOf([fontLayer(), work(bar(100), bar(300))]))
  workspace.moveStrokeInActive(0, 1)
  assert.equal(workspace.dirtyIds.value.has(LAYER_ID.strokes), true)
  assert.deepEqual(workspace.layers.value.find((l) => l.id === LAYER_ID.strokes)!.strokes.map((s) => s.median_points[0][1]), [330, 130])
  workspace.resetActiveEdits()
  assert.equal(workspace.dirtyIds.value.has(LAYER_ID.strokes), false)
  assert.deepEqual(workspace.layers.value.find((l) => l.id === LAYER_ID.strokes)!.strokes.map((s) => s.median_points[0][1]), [130, 330])
  assert.match(studio.message.value, /초기화했습니다/)
  workspace.resetActiveEdits()
  assert.match(studio.message.value, /되돌릴 변경이 없습니다/)
})

test('편집 대상 레이어가 없으면 가드는 조용히 막는다', () => {
  const { workspace, studio } = setupWorkspace([fontLayer()])
  workspace.activeLayerId.value = 'missing'
  workspace.moveStrokeInActive(0, 1)
  assert.equal(studio.error.value, '')
})
