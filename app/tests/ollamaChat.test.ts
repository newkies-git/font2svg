import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { HTTP_BAD_REQUEST, HTTP_OK } from '../server/http.ts'
import { buildSystemPrompt, chatWithOllama, parseChatRequest, sanitizeEdits } from '../server/ollamaChat.ts'
import { handleApi } from '../server/routes.ts'
import type { Workspace } from '../server/workspace.ts'
import type { ChatContext } from '../shared/types.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const context: ChatContext = {
  char: '丁',
  reading: '정',
  layerName: '작업 획',
  strokes: [1, 2, 3].map((order) => ({
    order,
    points: 2,
    width: 60,
    is_radical: 0,
    start_cap: 'NONE',
    end_cap: 'NONE',
    start: [0, 0],
    end: [10, 10],
  })),
}

function stubChat(content: string) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify({ message: { role: 'assistant', content } }), { status: 200 })
  }) as typeof fetch
  return calls
}

test('채팅 요청: 마지막이 사용자 메시지여야 하고, 잘못된 항목은 버린다', () => {
  const parsed = parseChatRequest({
    mode: 'chat',
    messages: [{ role: 'system', content: '무시' }, { role: 'user', content: '  안녕  ' }, { role: 'x' }],
  })
  assert.deepEqual(parsed.messages, [{ role: 'user', content: '안녕' }])
  assert.throws(() => parseChatRequest({ messages: [{ role: 'assistant', content: '답' }] }), /보낼 메시지/)
  assert.throws(() => parseChatRequest({ messages: [] }), /보낼 메시지/)
})

test('데이터 수정 모드는 글자·획 정보가 있어야 한다', () => {
  assert.throws(() => parseChatRequest({ mode: 'edit', messages: [{ role: 'user', content: '고쳐' }] }), /획 정보/)
  const parsed = parseChatRequest({ mode: 'edit', messages: [{ role: 'user', content: '고쳐' }], context })
  assert.equal(parsed.context?.strokes.length, 3)
})

test('수정 제안 검증: 범위 밖·모르는 op는 버리고 번호가 밀리는 수정은 하나만 받는다', () => {
  const edits = sanitizeEdits(
    [
      { op: 'set_radical', stroke: 1, value: 1 },
      { op: 'set_radical', stroke: 9, value: 1 },
      { op: 'set_cap', stroke: 2, end: 'end', value: 'POINTED' },
      { op: 'set_cap', stroke: 2, end: 'middle', value: 'POINTED' },
      { op: 'set_cap', stroke: 2, end: 'end', value: 'WRONG' },
      { op: 'explode', stroke: 1 },
      { op: 'delete', stroke: 3 },
      { op: 'merge_next', stroke: 1 },
      { op: 'reverse', stroke: 2 },
    ],
    3,
  )
  assert.deepEqual(edits, [
    { op: 'set_radical', stroke: 1, value: 1 },
    { op: 'set_cap', stroke: 2, end: 'end', value: 'POINTED' },
    { op: 'delete', stroke: 3 },
    { op: 'reverse', stroke: 2 },
  ])
  assert.deepEqual(sanitizeEdits('x', 3), [])
  assert.deepEqual(sanitizeEdits([{ op: 'delete', stroke: 1 }], 1), [])
  assert.deepEqual(sanitizeEdits([{ op: 'move', stroke: 3, delta: 1 }], 3), [])
  assert.deepEqual(sanitizeEdits([{ op: 'merge_next', stroke: 3 }], 3), [])
})

test('시스템 프롬프트: 수정 모드에만 수정 규칙이 들어가고 획 요약이 포함된다', () => {
  assert.doesNotMatch(buildSystemPrompt('chat', context), /edits/)
  const prompt = buildSystemPrompt('edit', context)
  assert.match(prompt, /edits/)
  assert.match(prompt, /3획: 중심선 2점/)
})

test('일반 채팅: /api/chat에 대화를 보내고 답을 돌려준다', async () => {
  const calls = stubChat('  안녕하세요  ')
  const result = await chatWithOllama(parseChatRequest({ messages: [{ role: 'user', content: '안녕' }] }))
  assert.deepEqual(result, { reply: '안녕하세요', edits: [], model: 'qwen3.5:9b' })
  assert.match(calls[0].url, /\/api\/chat$/)
  assert.equal(calls[0].body.format, undefined)
  const messages = calls[0].body.messages as { role: string }[]
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user'])
})

test('데이터 수정 채팅: JSON 응답에서 검증된 제안만 돌려준다', async () => {
  const calls = stubChat(JSON.stringify({ reply: '부수로 지정합니다', edits: [{ op: 'set_radical', stroke: 1, value: 1 }, { op: 'delete', stroke: 99 }] }))
  const result = await chatWithOllama(parseChatRequest({ mode: 'edit', model: 'm1', messages: [{ role: 'user', content: '1획을 부수로' }], context }))
  assert.deepEqual(result.edits, [{ op: 'set_radical', stroke: 1, value: 1 }])
  assert.equal(result.reply, '부수로 지정합니다')
  assert.equal(calls[0].body.model, 'm1')
  assert.ok(calls[0].body.format)
})

test('데이터 수정 채팅: JSON이 아닌 응답은 제안 없이 글만 돌려준다', async () => {
  stubChat('그냥 글입니다')
  const result = await chatWithOllama(parseChatRequest({ mode: 'edit', messages: [{ role: 'user', content: '?' }], context }))
  assert.deepEqual(result, { reply: '그냥 글입니다', edits: [], model: 'qwen3.5:9b' })
})

test('Ollama 연결 실패·HTTP 오류는 이유를 담은 오류가 된다', async () => {
  const request = parseChatRequest({ messages: [{ role: 'user', content: '안녕' }] })
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
  await assert.rejects(chatWithOllama(request), /연결할 수 없습니다/)
  globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch
  await assert.rejects(chatWithOllama(request), /HTTP 500/)
})

test('POST /api/ollama/chat: 정상은 200, 검증 실패는 400', async () => {
  stubChat('ok')
  const ws = {} as Workspace
  const call = (body: Record<string, unknown>) =>
    handleApi(ws, { method: 'POST', pathname: '/api/ollama/chat', searchParams: new URLSearchParams(), readBody: async () => body })
  const ok = await call({ messages: [{ role: 'user', content: '안녕' }] })
  assert.equal(ok.status, HTTP_OK)
  assert.equal((ok.body as { reply: string }).reply, 'ok')
  assert.equal((await call({ messages: [] })).status, HTTP_BAD_REQUEST)
})
