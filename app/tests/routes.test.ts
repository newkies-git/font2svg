import assert from 'node:assert/strict'
import test from 'node:test'
import { HTTP_BAD_REQUEST, HTTP_NOT_FOUND, HTTP_OK } from '../server/http.ts'
import { handleApi } from '../server/routes.ts'
import type { Workspace } from '../server/workspace.ts'

type Call = { name: string; args: unknown[] }

// 호출 기록만 남기는 가짜 작업 공간. overrides로 일부 메서드의 반환값을 바꾼다.
function fakeWorkspace(overrides: Record<string, (...args: unknown[]) => unknown> = {}) {
  const calls: Call[] = []
  const ws = new Proxy({}, {
    get: (_target, name: string) => (...args: unknown[]) => {
      calls.push({ name, args })
      return overrides[name] ? overrides[name](...args) : { called: name }
    },
  }) as unknown as Workspace
  return { ws, calls }
}

function request(method: string, path: string, body: Record<string, unknown> = {}) {
  const url = new URL(path, 'http://localhost')
  return { method, pathname: url.pathname, searchParams: url.searchParams, readBody: async () => body }
}

test('목록 조회는 q를 넘긴다', async () => {
  const { ws, calls } = fakeWorkspace({ listCharacters: () => [] })
  const result = await handleApi(ws, request('GET', '/api/characters?q=丁'))
  assert.equal(result.status, HTTP_OK)
  assert.deepEqual(calls[0], { name: 'listCharacters', args: ['丁'] })
})

test('글자 조회: 있으면 200, 없으면 404', async () => {
  const found = fakeWorkspace({ getCharacter: () => ({ char: '丁' }) })
  assert.equal((await handleApi(found.ws, request('GET', '/api/characters/U%2B4E01'))).status, HTTP_OK)
  assert.deepEqual(found.calls[0].args, ['U+4E01'])
  const missing = fakeWorkspace({ getCharacter: () => null })
  const result = await handleApi(missing.ws, request('GET', '/api/characters/U%2B4E01'))
  assert.equal(result.status, HTTP_NOT_FOUND)
  assert.deepEqual(result.body, { error: '없는 글자입니다.' })
})

test('글자 경로의 첫 구간은 U+로 시작해야 한다', async () => {
  const { ws, calls } = fakeWorkspace()
  const result = await handleApi(ws, request('GET', '/api/characters/abc'))
  assert.equal(result.status, HTTP_NOT_FOUND)
  assert.deepEqual(result.body, { error: '없는 API입니다.' })
  assert.equal(calls.length, 0)
})

test('정의되지 않은 경로와 메서드는 404', async () => {
  const { ws, calls } = fakeWorkspace()
  assert.equal((await handleApi(ws, request('GET', '/api/nope'))).status, HTTP_NOT_FOUND)
  assert.equal((await handleApi(ws, request('GET', '/api/characters/U%2B4E01/approve'))).status, HTTP_NOT_FOUND)
  assert.equal((await handleApi(ws, request('POST', '/api/characters'))).status, HTTP_NOT_FOUND)
  assert.equal(calls.length, 0)
})

test('레이어 경로: 저장·초기화·수신·적용·삭제', async () => {
  const { ws, calls } = fakeWorkspace()
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/layers/custom-1/save', { strokes: [1], paths: [2], action: '편집' }))
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/layers/mmh/reset'))
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/layers/naver/fetch'))
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/layers/mmh/apply', { mode: 'fit_font' }))
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/layers/mmh/apply', { mode: '이상한값' }))
  await handleApi(ws, request('DELETE', '/api/characters/U%2B4E01/layers/custom-1'))
  assert.deepEqual(calls.map((c) => c.name), ['saveLayer', 'resetLayer', 'fetchLayer', 'applyLayerToStrokes', 'applyLayerToStrokes', 'deleteLayer'])
  assert.deepEqual(calls[0].args, ['U+4E01', 'custom-1', { strokes: [1], paths: [2], action: '편집' }])
  assert.deepEqual(calls[3].args, ['U+4E01', 'mmh', 'fit_font', 'replace'])
  assert.deepEqual(calls[4].args, ['U+4E01', 'mmh', 'direct', 'replace'])
})

test('네이버 적용 경로는 추가와 교체를 구분한다', async () => {
  const { ws, calls } = fakeWorkspace()
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/apply-naver', { write: 'append' }))
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/apply-naver', {}))
  assert.deepEqual(calls.map((call) => call.args), [
    ['U+4E01', 'append'],
    ['U+4E01', 'replace'],
  ])
})

test('레이어 일괄 저장 경로', async () => {
  const { ws, calls } = fakeWorkspace()
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/layers/batch', { layers: [{ id: 'strokes' }, { id: 'mmh' }] }))
  assert.deepEqual(calls[0], { name: 'saveLayers', args: ['U+4E01', [{ id: 'strokes' }, { id: 'mmh' }]] })
  // 'batch'는 레이어 id 구간으로 오해되지 않는다(삭제는 DELETE 전용)
  const deleted = fakeWorkspace()
  await handleApi(deleted.ws, request('DELETE', '/api/characters/U%2B4E01/layers/batch'))
  assert.equal(deleted.calls[0].name, 'deleteLayer')
})

test('outline 경로: generate·map·refresh', async () => {
  const { ws, calls } = fakeWorkspace()
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/outline/generate', { sourceLayerId: 'mmh' }))
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/outline/generate', {}))
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/outline/map', { strokeIndex: 2, contours: [0, 1] }))
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/outline/refresh'))
  assert.deepEqual(calls.map((c) => c.name), ['generateOutline', 'generateOutline', 'mapOutlineStroke', 'refreshOutline'])
  assert.deepEqual(calls[0].args, ['U+4E01', 'mmh'])
  assert.deepEqual(calls[1].args, ['U+4E01', undefined])
  assert.deepEqual(calls[2].args, ['U+4E01', 2, [0, 1]])
})

test('일괄 작업의 limit은 숫자가 아니면 기본값', async () => {
  const { ws, calls } = fakeWorkspace()
  await handleApi(ws, request('POST', '/api/apply-font', { after: 'U+4E00', limit: 'x' }))
  assert.equal(calls[0].name, 'applyFontBatch')
  assert.equal(calls[0].args[0], 'U+4E00')
  assert.equal(typeof calls[0].args[1], 'number')
  assert.ok(Number.isFinite(calls[0].args[1] as number))
})

test('핸들러가 던진 오류와 본문 오류는 400', async () => {
  const thrower = fakeWorkspace({ approve: () => { throw new Error('승인 불가') } })
  const result = await handleApi(thrower.ws, request('POST', '/api/characters/U%2B4E01/approve'))
  assert.equal(result.status, HTTP_BAD_REQUEST)
  assert.deepEqual(result.body, { error: '승인 불가' })
  const { ws } = fakeWorkspace()
  const bad = await handleApi(ws, { ...request('POST', '/api/apply-font'), readBody: async () => { throw new Error('JSON 형식이 아닙니다.') } })
  assert.equal(bad.status, HTTP_BAD_REQUEST)
})

test('초기 글자 목록은 배열 본문과 {entries} 본문을 모두 받는다', async () => {
  const { ws, calls } = fakeWorkspace()
  await handleApi(ws, { ...request('POST', '/api/import'), readBody: async () => [{ 한자: '丁' }] as unknown as Record<string, unknown> })
  await handleApi(ws, request('POST', '/api/import', { entries: [{ 한자: '丙' }] }))
  assert.deepEqual(calls[0].args, [[{ 한자: '丁' }]])
  assert.deepEqual(calls[1].args, [[{ 한자: '丙' }]])
})

test('획 저장 경로는 입력을 검증한 획만 작업 공간에 넘긴다', async () => {
  const { ws, calls } = fakeWorkspace()
  const stroke = { outline_path: 'M 0 0 L 10 0 L 10 10 Z', median_points: [[1, 1], [9, 9]], stroke_width: 70, is_radical: 1 }
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/strokes', { strokes: [stroke], action: '편집' }))
  const sent = calls[0].args[1] as { stroke_order: number; start_cap_type: string }[]
  assert.equal(sent[0].stroke_order, 1)
  assert.equal(sent[0].start_cap_type, 'NONE')
  const bad = await handleApi(ws, request('POST', '/api/characters/U%2B4E01/strokes', { strokes: 'x' }))
  assert.equal(bad.status, HTTP_BAD_REQUEST)
  assert.equal(calls.length, 1, '형식이 틀리면 작업 공간을 호출하지 않는다')
})

test('레이어 저장: action은 문자열일 때만 넘기고 나머지 내용은 그대로 넘긴다', async () => {
  const { ws, calls } = fakeWorkspace()
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/layers/custom-1/save', { strokes: [1], action: 7, extra: 'x' }))
  assert.deepEqual(calls[0].args, ['U+4E01', 'custom-1', { strokes: [1], paths: undefined, action: undefined }])
})

test('복제와 윤곽 생성: 비었거나 문자열이 아닌 선택 값은 없는 값으로 넘긴다', async () => {
  const { ws, calls } = fakeWorkspace()
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/layers', { sourceLayerId: 'mmh', name: '사본' }))
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/layers', { sourceLayerId: '', name: 5 }))
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/outline/generate', { sourceLayerId: 'strokes' }))
  await handleApi(ws, request('POST', '/api/characters/U%2B4E01/outline/generate', { sourceLayerId: null }))
  assert.deepEqual(calls.map((call) => call.args), [
    ['U+4E01', 'mmh', '사본'],
    ['U+4E01', undefined, undefined],
    ['U+4E01', 'strokes'],
    ['U+4E01', undefined],
  ])
})
