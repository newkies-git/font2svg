import assert from 'node:assert/strict'
import test from 'node:test'
import { apiRequest, apiUrl, characterUrl } from '../src/lib/api.ts'

function stubFetch(response: { ok: boolean; body: unknown }, calls: { url: string; init?: RequestInit }[] = []) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return { ok: response.ok, json: async () => response.body } as Response
  }) as typeof fetch
  return calls
}

test('URL 조립: 각 구간을 인코딩한다', () => {
  assert.equal(characterUrl('U+4E01'), '/api/characters/U%2B4E01')
  assert.equal(characterUrl('U+4E01', 'layers', 'custom-1', 'save'), '/api/characters/U%2B4E01/layers/custom-1/save')
  assert.equal(characterUrl('U+4E01', 'layers', '가 나'), '/api/characters/U%2B4E01/layers/%EA%B0%80%20%EB%82%98')
  assert.equal(apiUrl('radicals'), '/api/radicals')
})

test('성공하면 JSON 본문을 돌려주고, 본문이 있으면 JSON으로 보낸다', async () => {
  const calls = stubFetch({ ok: true, body: { imported: 3 } })
  const result = await apiRequest<{ imported: number }>('/api/import', '실패', { method: 'POST', body: { entries: [] } })
  assert.equal(result.imported, 3)
  assert.equal(calls[0].init?.method, 'POST')
  assert.equal(calls[0].init?.body, JSON.stringify({ entries: [] }))
  assert.deepEqual(calls[0].init?.headers, { 'Content-Type': 'application/json' })
})

test('본문이 없으면 Content-Type 헤더를 보내지 않는다', async () => {
  const calls = stubFetch({ ok: true, body: {} })
  await apiRequest('/api/radicals', '실패')
  assert.equal(calls[0].init?.headers, undefined)
  assert.equal(calls[0].init?.method, 'GET')
})

test('실패하면 서버의 error 메시지를, 없으면 기본 메시지를 던진다', async () => {
  stubFetch({ ok: false, body: { error: '없는 글자입니다.' } })
  await assert.rejects(apiRequest('/x', '기본'), { message: '없는 글자입니다.' })
  stubFetch({ ok: false, body: {} })
  await assert.rejects(apiRequest('/x', '기본 메시지'), { message: '기본 메시지' })
})
