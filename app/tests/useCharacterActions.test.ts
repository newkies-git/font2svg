import assert from 'node:assert/strict'
import test, { afterEach, beforeEach } from 'node:test'
import { ref } from 'vue'
import { useCharacterActions } from '../src/composables/useCharacterActions.ts'
import { LAYER_ID } from '../shared/constants.ts'
import type { CharacterSummary } from '../shared/types.ts'
import { bar, detailOf, ENCODED_UNICODE, fakeApi, layerOf, markDirty, setupWorkspace } from './studioHarness.ts'

let api: ReturnType<typeof fakeApi>
beforeEach(() => { api = fakeApi() })
afterEach(() => api.restore())

const work = (...strokes: ReturnType<typeof bar>[]) => layerOf(LAYER_ID.strokes, 'STROKES', { name: '작업 획', strokes })
const summary = (unicode: string, char: string): CharacterSummary => ({
  unicode, char, grade: null, issue_reason: null, issue_status: null, in_font: 1, origin: 'MMH', reading: null, meaning: null,
  stroke_count: 1, last_modified_at: '', last_modified_by: 'user',
})
const URL_ROOT = `/api/characters/${ENCODED_UNICODE}`
const path = (call: { url: string }) => call.url.replace(URL_ROOT, '')

function setup(options: {
  strokes?: number
  confirm?: boolean | undefined
  choice?: 'replace' | 'append'
  chars?: CharacterSummary[]
} = {}) {
  const strokes = Array.from({ length: options.strokes ?? 1 }, (_, i) => bar(100 + i * 200))
  const harness = setupWorkspace([work(...strokes)])
  const chars = ref<CharacterSummary[]>(options.chars ?? [summary('U+4E00', '一')])
  const counters = { loadList: 0, confirm: 0, stopped: 0 }
  const actions = useCharacterActions(harness.studio, {
    chars,
    loadList: async () => { counters.loadList += 1 },
    syncFromDetail: harness.workspace.syncFromDetail,
    saveAllDirtyLayers: harness.workspace.saveAllDirtyLayers,
    dirtyIds: harness.workspace.dirtyIds,
    stopPlayback: () => { counters.stopped += 1 },
    workStrokeCount: () => harness.workspace.layers.value.find((layer) => layer.id === LAYER_ID.strokes)?.strokes.length ?? 0,
    confirmReplace: async () => { counters.confirm += 1; return options.confirm },
    confirmImport: async () => {
      counters.confirm += 1
      if (options.choice) return options.choice
      if (options.confirm === undefined) return undefined
      return options.confirm ? 'replace' : null
    },
  })
  return { ...harness, chars, counters, actions }
}

const fileEvent = (text: string | null) => {
  const input = { files: text === null ? [] : [{ text: async () => text }], value: 'C:\\fakepath\\x' }
  return { event: { target: input } as unknown as Event, input }
}

test('초기 목록 업로드: JSON을 entries로 보내고 등록 수를 안내한 뒤 목록을 다시 읽는다', async () => {
  const { actions, studio, counters } = setup()
  api.on('POST', /\/api\/import$/, { imported: 3 })
  await actions.uploadInitial(fileEvent('[{"한자":"丁"}]').event)
  assert.deepEqual(api.calls[0].body, { entries: [{ 한자: '丁' }] })
  assert.equal(studio.message.value, '3자 등록 완료. 획은 네이버·SVG·이미지로 직접 가져오세요.')
  assert.equal(counters.loadList, 1)
})

test('초기 목록 업로드: 파일이 없거나 JSON이 아니면 요청하지 않고 오류를 보인다', async () => {
  const { actions, studio } = setup()
  await actions.uploadInitial(fileEvent(null).event)
  assert.equal(api.calls.length, 0)
  await actions.uploadInitial(fileEvent('이건 JSON이 아님').event)
  assert.equal(api.calls.length, 0)
  assert.notEqual(studio.error.value, '')
  assert.equal(studio.busy.value, false)
})

test('글자 열기: 상세를 받아 화면에 반영하고 요약 메시지를 만든다', async () => {
  const { actions, studio, counters } = setup()
  const detail = detailOf([work(bar(100))], { issue_status: 'OPEN', issue_reason: '확인 필요', origin: 'NAVER' })
  api.on('GET', /\/api\/characters\/U%2B4E00$/, detail)
  await actions.openChar(summary('U+4E00', '一'))
  assert.equal(counters.stopped, 1, '재생을 멈춘다')
  assert.equal(studio.selected.value!.unicode, 'U+4E00')
  assert.match(studio.message.value, /^一 · 일 · 출처 NAVER/)
  assert.ok(studio.message.value.endsWith('확인 필요'))
})

test('글자 열기: 획이 없어도 레퍼런스를 자동으로 받지 않는다', async () => {
  const { actions, studio } = setup()
  api.on('GET', /\/api\/characters\/U%2B4E00$/, detailOf([work()], { strokes: [], issue_status: null }))
  await actions.openChar(summary('U+4E00', '一'))
  assert.deepEqual(api.calls.map((call) => call.method), ['GET'])
  assert.equal(studio.selected.value!.strokes.length, 0)
})

test('글자 열기 실패: 서버 오류를 보이고 busy를 푼다', async () => {
  const { actions, studio } = setup()
  api.on('GET', /\/api\/characters\/U%2B4E00$/, () => ({ status: 404, body: { error: '없는 글자입니다.' } }))
  await actions.openChar(summary('U+4E00', '一'))
  assert.equal(studio.error.value, '없는 글자입니다.')
  assert.equal(studio.busy.value, false)
})

test('첫 글자 열기: 목록이 비면 아무것도 하지 않는다', async () => {
  const empty = setup({ chars: [] })
  await empty.actions.openFirst()
  assert.equal(api.calls.length, 0)
  const filled = setup({ chars: [summary('U+4E00', '一'), summary('U+4E8C', '二')] })
  api.on('GET', /\/api\/characters\/U%2B4E00$/, detailOf([work(bar(100))]))
  await filled.actions.openFirst()
  assert.equal(api.calls.length, 1)
})

test('다시 읽기: 목록을 받은 뒤 보던 글자를 연다(목록에 없으면 열지 않는다)', async () => {
  const { actions, counters, chars } = setup()
  api.on('GET', /\/api\/characters\/U%2B4E00$/, detailOf([work(bar(100))]))
  await actions.reload()
  assert.equal(counters.loadList, 1)
  assert.equal(api.calls.length, 1)
  chars.value = []
  await actions.reload()
  assert.equal(api.calls.length, 1, '목록에서 사라졌으면 열지 않는다')
})

test('승인: approve를 호출하고 안내한 뒤 다시 읽는다', async () => {
  const { actions, studio } = setup({ chars: [] })
  api.on('POST', /\/approve$/, {})
  await actions.approve()
  assert.equal(path(api.calls[0]), '/approve')
  assert.equal(studio.message.value, '작업 데이터를 승인해 최종 획(strokes)으로 옮겼습니다.')
})

test('승인 실패: 서버 메시지를 보인다', async () => {
  const { actions, studio } = setup()
  api.on('POST', /\/approve$/, () => ({ status: 400, body: { error: '1획 중심선이 짧습니다.' } }))
  await actions.approve()
  assert.equal(studio.error.value, '1획 중심선이 짧습니다.')
})

test('SVG 가져오기: 파일을 읽어 보내고 입력값을 비운다(같은 파일 재선택 가능)', async () => {
  const { actions, studio } = setup({ chars: [] })
  api.on('POST', /\/import-svg$/, {})
  const { event, input } = fileEvent('<svg/>')
  await actions.importSvg(event)
  assert.deepEqual(api.calls[0].body, { svg: '<svg/>' })
  assert.equal(input.value, '')
  assert.equal(studio.message.value, 'SVG를 작업 데이터로 가져왔습니다. 확인 후 승인하세요.')
  const none = fileEvent(null)
  await actions.importSvg(none.event)
  assert.equal(api.calls.length, 1)
  assert.equal(none.input.value, '')
})

test('네이버 적용: 작업 획이 있으면 먼저 확인하고, 취소하면 요청하지 않는다', async () => {
  const declined = setup({ strokes: 2, confirm: false })
  await declined.actions.applyNaver()
  assert.equal(declined.counters.confirm, 1)
  assert.equal(api.calls.length, 0)
  const noDialog = setup({ strokes: 2, confirm: undefined })
  await noDialog.actions.applyNaver()
  assert.equal(api.calls.length, 0, '확인 창이 없으면 덮어쓰지 않는다')
})

test('네이버 적용: 추가를 고르면 기존 획 뒤에 붙인다', async () => {
  const { actions, studio } = setup({ strokes: 2, choice: 'append', chars: [] })
  api.on('POST', /\/apply-naver$/, {})
  await actions.applyNaver()
  assert.deepEqual(api.calls[0].body, { write: 'append' })
  assert.equal(studio.message.value, '네이버 한자사전 획을 작업 획 뒤에 추가했습니다.')
})

test('네이버 적용: 확인하면 적용하고, 작업 획이 없으면 묻지 않는다', async () => {
  const confirmed = setup({ strokes: 2, confirm: true, chars: [] })
  api.on('POST', /\/apply-naver$/, {})
  await confirmed.actions.applyNaver()
  assert.equal(path(api.calls[0]), '/apply-naver')
  assert.deepEqual(api.calls[0].body, { write: 'replace' })
  assert.equal(confirmed.studio.message.value, '네이버 한자사전 획순을 적용했습니다.')
  api.calls.length = 0
  const empty = setup({ strokes: 0, chars: [] })
  await empty.actions.applyNaver()
  assert.equal(empty.counters.confirm, 0)
  assert.equal(path(api.calls[0]), '/apply-naver')
})

test('되돌리기: 응답으로 화면을 바꾸고, 실패하면 오류를 보인다', async () => {
  const { actions, studio, workspace } = setup()
  api.on('POST', /\/undo$/, detailOf([work(bar(100), bar(300))]))
  await actions.undo()
  assert.equal(studio.message.value, '이전 편집 상태로 복원 완료')
  assert.equal(workspace.layers.value.find((layer) => layer.id === LAYER_ID.strokes)!.strokes.length, 2)
  api.calls.length = 0
  const failing = setup()
  failing.studio.error.value = ''
  api.on('POST', /\/undo$/, () => ({ status: 400, body: { error: '되돌릴 편집이 없습니다.' } }))
  await failing.actions.undo()
  assert.equal(failing.studio.error.value, '되돌릴 편집이 없습니다.')
})

test('컴파일: 저장 안 된 작업 획을 먼저 저장하고, 저장이 실패하면 컴파일하지 않는다', async () => {
  const saved = setup({ chars: [] })
  markDirty(saved.workspace, LAYER_ID.strokes)
  api.on('POST', /\/layers\/batch$/, detailOf([work(bar(100))]))
  api.on('POST', /\/compile$/, {})
  await saved.actions.compileChar()
  assert.deepEqual(api.calls.map(path), ['/layers/batch', '/compile'])
  assert.equal(saved.studio.message.value, '배포용 컴파일 JSON 생성 완료')
  api.calls.length = 0
  const failing = setup({ chars: [] })
  markDirty(failing.workspace, LAYER_ID.strokes)
  api.on('POST', /\/layers\/batch$/, () => ({ status: 400, body: { error: '저장 실패' } }))
  await failing.actions.compileChar()
  assert.equal(api.calls.some((call) => call.url.endsWith('/compile')), false)
  assert.equal(failing.studio.error.value, '저장 실패')
})

test('컴파일 실패: 검증 메시지를 보이고 그래도 다시 읽는다', async () => {
  const { actions, studio, counters } = setup()
  api.on('POST', /\/compile$/, () => ({ status: 400, body: { error: '1획 경로가 올바르지 않습니다.' } }))
  api.on('GET', /\/api\/characters\/U%2B4E00$/, detailOf([work(bar(100))]))
  await actions.compileChar()
  assert.equal(counters.loadList, 1, 'reload를 거친다')
  assert.equal(studio.error.value, '', '다시 읽으면서 오류 표시가 지워진다')
})

test('글자가 선택되지 않았으면 글자 동작은 요청하지 않는다', async () => {
  const { actions, studio } = setup()
  studio.selected.value = null
  await actions.approve()
  await actions.importSvg(fileEvent('<svg/>').event)
  await actions.applyNaver()
  await actions.undo()
  await actions.compileChar()
  await actions.reload()
  assert.equal(api.calls.length, 0)
})
