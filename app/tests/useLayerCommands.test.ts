import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import { LAYER_ID } from '../shared/constants.ts'
import { bar, detailOf, ENCODED_UNICODE, fakeApi, layerOf, markDirty, setupWorkspace } from './studioHarness.ts'

let api: ReturnType<typeof fakeApi>
beforeEach(() => { api = fakeApi() })
afterEach(() => api.restore())

const work = (...strokes: ReturnType<typeof bar>[]) => layerOf(LAYER_ID.strokes, 'STROKES', { name: '작업 획', strokes })
const fontLayer = (paths: string[] = ['M 0 0 L 9 0 L 9 9 Z']) => layerOf(LAYER_ID.font, 'FONT', { name: '궁서체', paths })
const custom = (id: string, ...strokes: ReturnType<typeof bar>[]) => layerOf(id, 'CUSTOM', { name: `사용자 ${id}`, strokes })
const base = () => `/api/characters/${ENCODED_UNICODE}`

test('saveActiveLayer: 작업 획은 strokes·paths·action을, 윤곽 전용 궁서체는 paths만 보낸다', async () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work(bar(100))])
  api.on('POST', /\/layers\/strokes\/save$/, detailOf([fontLayer(), work(bar(100), bar(300))]))
  await workspace.saveActiveLayer()
  assert.equal(api.calls[0].url, `${base()}/layers/strokes/save`)
  assert.deepEqual(api.calls[0].body, { strokes: [bar(100)], action: '작업 획 편집' })
  assert.equal(studio.message.value, "'작업 획' 레이어 저장 완료")
  assert.equal(studio.selected.value!.strokes.length, 2)

  workspace.selectLayer(LAYER_ID.font)
  api.on('POST', /\/layers\/font\/save$/, detailOf([fontLayer(), work(bar(100))]))
  await workspace.saveActiveLayer('윤곽 정리')
  assert.deepEqual(api.calls.at(-1)!.body, { paths: ['M 0 0 L 9 0 L 9 9 Z'], action: '윤곽 정리' })
})

test('저장 전에 보류 중인 표시 설정을 먼저 보낸다', async () => {
  const { workspace } = setupWorkspace([fontLayer(), work(bar(100))])
  api.on('POST', /\/layers-meta$/, {})
  api.on('POST', /\/layers\/strokes\/save$/, detailOf([fontLayer(), work(bar(100))]))
  workspace.toggleLayerLock(LAYER_ID.strokes)
  await workspace.saveActiveLayer()
  assert.deepEqual(api.urls().map((line) => line.split(' ')[1]), ['/layers-meta', '/layers/strokes/save'])
  assert.deepEqual(api.calls[0].body, { patches: [{ id: LAYER_ID.strokes, locked: true }] })
})

test('저장 실패: 서버 오류 메시지를 보이고 dirty를 유지한다', async () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work(bar(100))])
  api.on('POST', /\/layers\/strokes\/save$/, () => ({ status: 400, body: { error: '잠긴 레이어는 저장할 수 없습니다.' } }))
  markDirty(workspace, LAYER_ID.strokes)
  await workspace.saveActiveLayer()
  assert.equal(studio.error.value, '잠긴 레이어는 저장할 수 없습니다.')
  assert.equal(workspace.dirtyIds.value.has(LAYER_ID.strokes), true)
  assert.equal(studio.busy.value, false, '실패해도 busy는 풀린다')
})

test('모두 저장: dirty 레이어를 한 요청(배치)으로 보낸다', async () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work(bar(100)), custom('c1', bar(300))])
  api.on('POST', /\/layers\/batch$/, detailOf([fontLayer(), work(bar(100)), custom('c1', bar(300))]))
  markDirty(workspace, LAYER_ID.strokes)
  markDirty(workspace, 'c1')
  await workspace.saveAllDirtyLayers()
  assert.equal(api.calls.filter((call) => call.url.endsWith('/layers/batch')).length, 1)
  const body = api.calls.at(-1)!.body as { layers: { id: string; strokes: unknown[]; action: string }[] }
  assert.deepEqual(body.layers.map((layer) => layer.id), [LAYER_ID.strokes, 'c1'])
  assert.equal(body.layers[1].action, '사용자 c1 편집')
  assert.equal(studio.message.value, '변경된 레이어 2개를 모두 저장했습니다.')
  assert.equal(workspace.dirtyIds.value.size, 0)
})

test('모두 저장: dirty가 없으면 활성 레이어 하나를 저장한다', async () => {
  const { workspace } = setupWorkspace([fontLayer(), work(bar(100))])
  api.on('POST', /\/layers\/strokes\/save$/, detailOf([fontLayer(), work(bar(100))]))
  await workspace.saveAllDirtyLayers()
  assert.equal(api.calls[0].url, `${base()}/layers/strokes/save`)
})

test('모두 저장 실패: 서버 메시지가 없으면 하나도 저장되지 않았다고 알린다', async () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work(bar(100))])
  api.on('POST', /\/layers\/batch$/, () => ({ status: 500, body: {} }))
  markDirty(workspace, LAYER_ID.strokes)
  await workspace.saveAllDirtyLayers()
  assert.equal(studio.error.value, '레이어 저장에 실패했습니다. 변경한 레이어는 하나도 저장되지 않았습니다.')
  assert.equal(workspace.dirtyIds.value.has(LAYER_ID.strokes), true)
})

test('원본 복원: reset을 호출하고 안내를 보인다', async () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work(bar(100)), custom('c1', bar(300))])
  api.on('POST', /\/layers\/c1\/reset$/, detailOf([fontLayer(), work(bar(100))]))
  await workspace.resetLayerToOriginal('c1')
  assert.equal(api.calls[0].url, `${base()}/layers/c1/reset`)
  assert.equal(studio.message.value, '레이어를 원본 데이터로 복원했습니다.')
})

test('레퍼런스 수신: 저장 전 편집 중이던 다른 레이어의 도형을 유지하고 받은 레이어를 보인다', async () => {
  const naver = layerOf(LAYER_ID.naver, 'NAVER', { name: '네이버 획순', available: false, locked: false })
  const { workspace, studio } = setupWorkspace([fontLayer(), naver, work(bar(100)), custom('c1', bar(300))])
  // 사용자 레이어를 편집했지만 아직 저장하지 않은 상태
  workspace.layers.value.find((layer) => layer.id === 'c1')!.strokes = [bar(300), bar(500)]
  markDirty(workspace, 'c1')
  const fetched = detailOf([fontLayer(), layerOf(LAYER_ID.naver, 'NAVER', { name: '네이버 획순', strokes: [bar(700)] }), work(bar(100)), custom('c1', bar(300))])
  api.on('POST', /\/layers\/naver\/fetch$/, fetched)
  await workspace.fetchReferenceForLayer(LAYER_ID.naver)
  const c1 = workspace.layers.value.find((layer) => layer.id === 'c1')!
  assert.equal(c1.strokes.length, 2, '서버 응답이 미저장 편집을 덮지 않는다')
  assert.equal(workspace.dirtyIds.value.has('c1'), true)
  assert.equal(workspace.layers.value.find((layer) => layer.id === LAYER_ID.naver)!.strokes.length, 1)
  assert.equal(workspace.activeLayerId.value, LAYER_ID.naver)
  assert.equal(studio.message.value, "'네이버 획순' 레이어를 수신해 표시했습니다.")
})

test('레퍼런스 수신: keepActiveSelection이면 선택한 레이어를 유지한다', async () => {
  const naver = layerOf(LAYER_ID.naver, 'NAVER', { available: false })
  const { workspace } = setupWorkspace([fontLayer(), naver, work(bar(100))])
  workspace.selectLayer(LAYER_ID.strokes)
  api.on('POST', /\/layers\/naver\/fetch$/, detailOf([fontLayer(), layerOf(LAYER_ID.naver, 'NAVER', { strokes: [bar(700)] }), work(bar(100))]))
  await workspace.fetchReferenceForLayer(LAYER_ID.naver, true)
  assert.equal(workspace.activeLayerId.value, LAYER_ID.strokes)
})

test('작업 획에 적용: 수정 중인 레이어를 먼저 저장하고, 저장이 실패하면 적용하지 않는다', async () => {
  const mmh = layerOf(LAYER_ID.mmh, 'MMH', { name: 'Hanzi', strokes: [bar(100)], locked: false })
  const { workspace, studio } = setupWorkspace([fontLayer(), mmh, work()])
  markDirty(workspace, LAYER_ID.mmh)
  api.on('POST', /\/layers\/batch$/, () => ({ status: 400, body: { error: '저장 실패' } }))
  api.on('POST', /\/layers\/mmh\/apply$/, detailOf([fontLayer(), mmh, work(bar(100))]))
  await workspace.applyLayerToWorkStrokes(LAYER_ID.mmh, 'direct')
  assert.equal(api.calls.some((call) => call.url.endsWith('/apply')), false)
  assert.equal(studio.error.value, '저장 실패')
})

test('작업 획에 적용: 저장 뒤 apply를 호출하고 작업 획 레이어로 옮긴다(모드별 안내)', async () => {
  const mmh = layerOf(LAYER_ID.mmh, 'MMH', { strokes: [bar(100)] })
  const { workspace, studio, reloaded } = setupWorkspace([fontLayer(), mmh, work()])
  api.on('POST', /\/layers\/mmh\/apply$/, detailOf([fontLayer(), mmh, work(bar(100))]))
  await workspace.applyLayerToWorkStrokes(LAYER_ID.mmh, 'fit_font')
  assert.deepEqual(api.calls.at(-1)!.body, { mode: 'fit_font' })
  assert.equal(workspace.activeLayerId.value, LAYER_ID.strokes)
  assert.match(studio.message.value, /궁서체 윤곽을 분할해/)
  assert.equal(reloaded.count, 1)
  await workspace.applyLayerToWorkStrokes(LAYER_ID.mmh, 'direct')
  assert.match(studio.message.value, /획 데이터를 작업 획에 적용/)
})

test('윤곽 재분할: 활성 레이어 중심선을 보내고 응답으로 획을 바꾼다', async () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work(bar(100), bar(300))])
  const outlines = [bar(100).outline_path, bar(300).outline_path]
  api.on('POST', /\/resegment$/, { outlines, medians: [[[1, 1], [2, 2]], [[3, 3], [4, 4]]], widths: [55, 66] })
  await workspace.resegmentActiveByFont()
  assert.deepEqual((api.calls[0].body as { medians: unknown[] }).medians, [bar(100).median_points, bar(300).median_points])
  const strokes = workspace.layers.value.find((layer) => layer.id === LAYER_ID.strokes)!.strokes
  assert.deepEqual(strokes.map((stroke) => stroke.stroke_width), [55, 66])
  assert.deepEqual(strokes[0].median_points, [[1, 1], [2, 2]])
  assert.match(studio.message.value, /재분할했습니다/)
  assert.equal(workspace.dirtyIds.value.has(LAYER_ID.strokes), true)
})

test('윤곽 재분할: 잠겼거나 획이 없으면 요청하지 않는다', async () => {
  const locked = setupWorkspace([fontLayer(), work(bar(100))])
  locked.workspace.layers.value.find((layer) => layer.id === LAYER_ID.strokes)!.locked = true
  await locked.workspace.resegmentActiveByFont()
  const empty = setupWorkspace([fontLayer(), work()])
  await empty.workspace.resegmentActiveByFont()
  assert.equal(api.calls.length, 0)
})

test('획 윤곽(OUTLINE): 생성·매핑·갱신 요청과 안내 메시지', async () => {
  const outline = layerOf(LAYER_ID.outline, 'OUTLINE', { name: '획 윤곽' })
  const { workspace, studio } = setupWorkspace([fontLayer(), outline, work(bar(100))])
  const after = detailOf([fontLayer(), outline, work(bar(100))])
  api.on('POST', /\/outline\/(generate|map|refresh)$/, after)
  await workspace.generateOutlineLayer(LAYER_ID.strokes)
  assert.equal(api.calls[0].url, `${base()}/outline/generate`)
  assert.deepEqual(api.calls[0].body, { sourceLayerId: LAYER_ID.strokes })
  assert.equal(workspace.activeLayerId.value, LAYER_ID.outline)
  await workspace.mapOutlineContours(1, [0, 2])
  assert.deepEqual(api.calls.at(-1)!.body, { strokeIndex: 1, contours: [0, 2] })
  assert.equal(studio.message.value, '2획을 궁서체 윤곽 1, 3번에 매핑했습니다.')
  await workspace.mapOutlineContours(0, [])
  assert.equal(studio.message.value, '1획 매핑을 해제했습니다.')
  await workspace.refreshOutlineMapping()
  assert.equal(api.calls.at(-1)!.url, `${base()}/outline/refresh`)
})

test('윤곽 작업: 저장 안 된 윤곽 레이어 편집을 먼저 저장한다', async () => {
  const outline = layerOf(LAYER_ID.outline, 'OUTLINE', { strokes: [bar(100)] })
  const { workspace } = setupWorkspace([fontLayer(), outline, work(bar(100))])
  api.on('POST', /\/layers\/batch$/, detailOf([fontLayer(), outline, work(bar(100))]))
  api.on('POST', /\/outline\/map$/, detailOf([fontLayer(), outline, work(bar(100))]))
  markDirty(workspace, LAYER_ID.outline)
  await workspace.mapOutlineContours(0, [1])
  assert.deepEqual(api.urls().map((line) => line.split(' ')[1]), ['/layers/batch', '/outline/map'])
})

test('레이어 복제와 삭제: 복제본을 선택하고, 사용자 레이어만 삭제한다', async () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work(bar(100))])
  const copied = detailOf([fontLayer(), work(bar(100)), custom('c9', bar(100))])
  api.on('POST', /\/layers$/, { createdId: 'c9', detail: copied })
  await workspace.duplicateActiveLayer()
  assert.equal(workspace.activeLayerId.value, 'c9')
  assert.equal(studio.message.value, "'작업 획' 레이어를 복제했습니다.")
  api.on('DELETE', /\/layers\/c9$/, detailOf([fontLayer(), work(bar(100))]))
  await workspace.deleteActiveCustomLayer()
  assert.equal(api.calls.at(-1)!.method, 'DELETE')
  assert.equal(workspace.activeLayerId.value, LAYER_ID.strokes)
  assert.equal(studio.message.value, "'사용자 c9' 레이어를 삭제했습니다.")
  const before = api.calls.length
  await workspace.deleteActiveCustomLayer() // 작업 획은 삭제 대상이 아니다
  assert.equal(api.calls.length, before)
})

test('글자가 선택되지 않았으면 어떤 명령도 요청하지 않는다', async () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work(bar(100))])
  studio.selected.value = null
  await workspace.saveActiveLayer()
  await workspace.saveAllDirtyLayers()
  await workspace.resetLayerToOriginal()
  await workspace.fetchReferenceForLayer(LAYER_ID.naver)
  await workspace.applyLayerToWorkStrokes(LAYER_ID.mmh, 'direct')
  await workspace.generateOutlineLayer()
  await workspace.duplicateActiveLayer()
  assert.equal(api.calls.length, 0)
})
