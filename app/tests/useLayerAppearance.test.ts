import assert from 'node:assert/strict'
import test, { afterEach, beforeEach, mock } from 'node:test'
import { LAYER_ID, META_PATCH_DEBOUNCE_MS } from '../shared/constants.ts'
import { bar, detailOf, fakeApi, layerOf, setupWorkspace } from './studioHarness.ts'

let api: ReturnType<typeof fakeApi>
beforeEach(() => {
  api = fakeApi()
  mock.timers.enable({ apis: ['setTimeout'] })
})
afterEach(() => {
  mock.timers.reset()
  api.restore()
})

const work = () => layerOf(LAYER_ID.strokes, 'STROKES', { name: '작업 획', strokes: [bar(100)] })
const fontLayer = () => layerOf(LAYER_ID.font, 'FONT', { name: '궁서체', paths: ['M 0 0 Z'] })
const naver = (available = false) => layerOf(LAYER_ID.naver, 'NAVER', { name: '네이버 획순', available, visible: false, strokes: available ? [bar(100)] : [] })
const patchesSent = () => api.calls.filter((call) => call.url.endsWith('/layers-meta')).map((call) => (call.body as { patches: object[] }).patches)
const flushTimers = async () => {
  mock.timers.tick(META_PATCH_DEBOUNCE_MS)
  await new Promise((resolve) => setImmediate(resolve)) // 비동기 flush가 끝나기를 기다린다
}

test('표시 설정 변경은 잠시 모아서 한 번에 보낸다(같은 레이어는 병합)', async () => {
  const { workspace } = setupWorkspace([fontLayer(), work()])
  api.on('POST', /\/layers-meta$/, {})
  workspace.toggleLayerLock(LAYER_ID.strokes)
  workspace.setLayerOpacity(LAYER_ID.strokes, 0.5)
  workspace.setLayerColor(LAYER_ID.font, 'blue')
  assert.equal(patchesSent().length, 0, '디바운스 시간 전에는 보내지 않는다')
  await flushTimers()
  assert.deepEqual(patchesSent(), [[{ id: LAYER_ID.strokes, locked: true, opacity: 0.5 }, { id: LAYER_ID.font, label_color: 'blue' }]])
})

test('디바운스: 변경이 이어지면 마지막 변경 뒤에 한 번만 보낸다', async () => {
  const { workspace } = setupWorkspace([fontLayer(), work()])
  api.on('POST', /\/layers-meta$/, {})
  workspace.toggleLayerLock(LAYER_ID.strokes)
  mock.timers.tick(META_PATCH_DEBOUNCE_MS - 1)
  workspace.toggleLayerLock(LAYER_ID.strokes) // 타이머가 다시 시작된다
  mock.timers.tick(META_PATCH_DEBOUNCE_MS - 1)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(patchesSent().length, 0)
  await flushTimers()
  assert.equal(patchesSent().length, 1)
  assert.deepEqual(patchesSent()[0], [{ id: LAYER_ID.strokes, locked: false }])
})

test('표시 설정 저장이 실패해도 편집을 막지 않는다', async () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work()])
  api.on('POST', /\/layers-meta$/, () => ({ status: 500, body: { error: '디스크 가득' } }))
  workspace.toggleLayerLock(LAYER_ID.strokes)
  await flushTimers()
  assert.equal(studio.error.value, '', '화면 오류로 올리지 않는다')
  assert.equal(patchesSent().length, 1, '실패한 변경은 다시 보내지 않는다(대기열은 비워진다)')
})

test('글자가 선택되지 않았으면 표시 설정을 보내지 않는다', async () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work()])
  workspace.toggleLayerLock(LAYER_ID.strokes)
  studio.selected.value = null
  await flushTimers()
  assert.equal(patchesSent().length, 0)
})

test('잠금·투명도·이름·색: 값을 바꾸고 안내한다', () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work()])
  const target = () => workspace.layers.value.find((layer) => layer.id === LAYER_ID.strokes)!
  workspace.toggleLayerLock(LAYER_ID.strokes)
  assert.equal(target().locked, true)
  assert.equal(studio.message.value, "'작업 획' 레이어를 잠갔습니다.")
  workspace.toggleLayerLock(LAYER_ID.strokes)
  assert.equal(studio.message.value, "'작업 획' 레이어 잠금을 해제했습니다.")
  workspace.setLayerOpacity(LAYER_ID.strokes, 0.456)
  assert.equal(target().opacity, 0.46)
  workspace.setLayerOpacity(LAYER_ID.strokes, 7)
  assert.equal(target().opacity, 1)
  workspace.setLayerOpacity(LAYER_ID.strokes, -3)
  assert.equal(target().opacity, 0)
  workspace.setLayerColor(LAYER_ID.strokes, 'rose')
  assert.equal(target().label_color, 'rose')
})

test('이름 변경: 앞뒤 공백을 지우고, 빈 이름·같은 이름은 무시한다', async () => {
  const { workspace } = setupWorkspace([fontLayer(), work()])
  api.on('POST', /\/layers-meta$/, {})
  workspace.renameLayer(LAYER_ID.strokes, '   ')
  workspace.renameLayer(LAYER_ID.strokes, '작업 획')
  await flushTimers()
  assert.equal(patchesSent().length, 0)
  workspace.renameLayer(LAYER_ID.strokes, '  새 이름 ')
  assert.equal(workspace.layers.value.find((layer) => layer.id === LAYER_ID.strokes)!.name, '새 이름')
  await flushTimers()
  assert.deepEqual(patchesSent()[0], [{ id: LAYER_ID.strokes, name: '새 이름' }])
})

test('눈 아이콘: 개별 표시/숨김 토글과 안내', () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), work()])
  const font = () => workspace.layers.value.find((layer) => layer.id === LAYER_ID.font)!
  workspace.toggleLayerVisible(LAYER_ID.font)
  assert.equal(font().visible, false)
  assert.equal(studio.message.value, "'궁서체' 레이어를 숨겼습니다.")
  workspace.toggleLayerVisible(LAYER_ID.font)
  assert.equal(font().visible, true)
  assert.equal(studio.message.value, "'궁서체' 레이어를 표시합니다.")
})

test('받지 않은 레퍼런스 레이어를 켜면 숨김 해제 대신 수신을 요청한다', async () => {
  const { workspace } = setupWorkspace([fontLayer(), naver(false), work()])
  api.on('POST', /\/layers\/naver\/fetch$/, detailOf([fontLayer(), naver(true), work()]))
  workspace.toggleLayerVisible(LAYER_ID.naver)
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(api.calls.some((call) => call.url.endsWith('/layers/naver/fetch')))
  assert.equal(workspace.layers.value.find((layer) => layer.id === LAYER_ID.naver)!.available, true)
})

test('단독 보기: 한 레이어만 켜고, 다시 누르면 이전 표시 상태로 복원한다', () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), naver(true), work()])
  const visible = () => Object.fromEntries(workspace.layers.value.map((layer) => [layer.id, layer.visible]))
  const before = visible()
  workspace.soloLayer(LAYER_ID.font)
  assert.deepEqual(visible(), { [LAYER_ID.font]: true, [LAYER_ID.naver]: false, [LAYER_ID.strokes]: false })
  assert.equal(workspace.isSoloed(LAYER_ID.font), true)
  assert.equal(studio.message.value, "'궁서체' 레이어만 단독 표시합니다. (다시 누르면 복원)")
  workspace.soloLayer(LAYER_ID.font)
  assert.deepEqual(visible(), before)
  assert.equal(studio.message.value, '이전 레이어 표시 상태로 복원했습니다.')
})

test('Alt-클릭은 단독 보기이고, 일반 토글은 복원 기록을 지운다', () => {
  const { workspace, studio } = setupWorkspace([fontLayer(), naver(true), work()])
  workspace.toggleLayerVisible(LAYER_ID.font, true)
  assert.equal(workspace.isSoloed(LAYER_ID.font), true)
  workspace.toggleLayerVisible(LAYER_ID.strokes) // 일반 토글: 복원 기록을 버린다
  workspace.toggleLayerVisible(LAYER_ID.strokes)
  assert.equal(workspace.isSoloed(LAYER_ID.font), true)
  workspace.soloLayer(LAYER_ID.font) // 기록이 없으니 복원이 아니라 새 단독 보기다
  assert.equal(studio.message.value, "'궁서체' 레이어만 단독 표시합니다. (다시 누르면 복원)")
})

test('표시 프리셋: 전체·작업·없음', () => {
  const { workspace } = setupWorkspace([fontLayer(), naver(false), naver(true), work()].map((layer, index) => (index === 2 ? { ...layer, id: LAYER_ID.mmh, kind: 'MMH' as const } : layer)))
  const visible = () => Object.fromEntries(workspace.layers.value.map((layer) => [layer.id, layer.visible]))
  workspace.setPresetVisibility('none')
  assert.ok(Object.values(visible()).every((value) => value === false))
  workspace.setPresetVisibility('work')
  assert.deepEqual(visible(), { [LAYER_ID.font]: true, [LAYER_ID.naver]: false, [LAYER_ID.mmh]: false, [LAYER_ID.strokes]: true })
  workspace.setPresetVisibility('all')
  assert.deepEqual(visible(), { [LAYER_ID.font]: true, [LAYER_ID.naver]: false, [LAYER_ID.mmh]: true, [LAYER_ID.strokes]: true }, '받지 않은 레이어는 켜지 않는다')
})

test('직접 표시 지정: 같은 값이면 변경하지 않는다', async () => {
  const { workspace } = setupWorkspace([fontLayer(), work()])
  api.on('POST', /\/layers-meta$/, {})
  workspace.setLayerVisibleDirect(LAYER_ID.font, true)
  await flushTimers()
  assert.equal(patchesSent().length, 0)
  workspace.setLayerVisibleDirect(LAYER_ID.font, false)
  await flushTimers()
  assert.deepEqual(patchesSent()[0], [{ id: LAYER_ID.font, visible: false }])
})

test('레이어 순서 이동: 패널 순서대로 z_index를 다시 매기고 바뀐 것만 보낸다', async () => {
  const { workspace } = setupWorkspace([fontLayer(), work(), layerOf(LAYER_ID.medians, 'MEDIANS')])
  api.on('POST', /\/layers-meta$/, {})
  // 패널은 z가 큰 쪽이 위: [medians(2), strokes(1), font(0)]. 위의 medians를 맨 아래(font 자리)로 옮긴다.
  workspace.moveLayerOrder(LAYER_ID.medians, LAYER_ID.font)
  const z = Object.fromEntries(workspace.layers.value.map((layer) => [layer.id, layer.z_index]))
  assert.deepEqual(z, { [LAYER_ID.medians]: 0, [LAYER_ID.font]: 1, [LAYER_ID.strokes]: 2 })
  await flushTimers()
  assert.equal((patchesSent()[0] as { id: string }[]).length, 3)
  workspace.moveLayerOrder(LAYER_ID.font, LAYER_ID.font) // 같은 자리는 무시
  workspace.moveLayerOrder('missing', LAYER_ID.font)
  await flushTimers()
  assert.equal(patchesSent().length, 1)
})
