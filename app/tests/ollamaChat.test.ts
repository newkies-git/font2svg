import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test, { after, afterEach } from 'node:test'
import { HTTP_BAD_REQUEST, HTTP_OK } from '../server/http.ts'
import { buildSystemPrompt, chatWithOllama, parseChatRequest } from '../server/ollamaChat.ts'
import { handleApi } from '../server/routes.ts'
import { strokesFingerprint } from '../server/strokeEdits.ts'
import { createWorkspace } from '../server/workspace.ts'
import { rectPath, strokeOf, tempDir } from './helpers.ts'

const root = tempDir()
const ws = createWorkspace(root)
const originalFetch = globalThis.fetch
after(() => {
  ws.close()
  fs.rmSync(root, { recursive: true, force: true })
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

ws.importInitial([
  { 한자: '丁', 음: '정', 구분: '중등' },
  { 한자: '丙', 음: '병', 구분: '중등' },
])
const bar = (y: number) => strokeOf(rectPath(100, y, 400, y + 60), [[110, y + 30], [390, y + 30]])
ws.updateStrokes('U+4E01', [bar(100), bar(300), bar(500)] as never, '초기')

type Step = { content?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] }

// 호출마다 다음 단계를 돌려주고, 받은 메시지를 기록하는 가짜 Ollama.
function scriptOllama(steps: Step[]) {
  const requests: { messages: { role: string; content?: string }[]; tools: unknown[] }[] = []
  let call = 0
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    requests.push({ messages: JSON.parse(JSON.stringify(body.messages)), tools: body.tools })
    const step = steps[Math.min(call++, steps.length - 1)]
    return new Response(JSON.stringify({ message: { role: 'assistant', content: step.content ?? '', tool_calls: step.tool_calls } }), { status: 200 })
  }) as typeof fetch
  return requests
}

const fp = (unicode: string) => strokesFingerprint(ws.getCharacter(unicode)!.strokes)
const parse = (content: string, mode = 'chat') => parseChatRequest({ mode, messages: [{ role: 'user', content }] })

test('채팅 요청: 마지막이 사용자 메시지여야 하고, 잘못된 항목은 버린다', () => {
  const parsed = parseChatRequest({ messages: [{ role: 'system', content: '무시' }, { role: 'user', content: '  안녕  ' }, { role: 'x' }] })
  assert.deepEqual(parsed.messages, [{ role: 'user', content: '안녕' }])
  assert.throws(() => parseChatRequest({ messages: [{ role: 'assistant', content: '답' }] }), /보낼 메시지/)
  assert.throws(() => parseChatRequest({ messages: [] }), /보낼 메시지/)
  assert.deepEqual(parseChatRequest({ messages: [{ role: 'user', content: 'a' }], current: { unicode: 'U+4E01', char: '丁' } }).current, { unicode: 'U+4E01', char: '丁' })
})

test('시스템 프롬프트: 모드에 따라 수정 규칙이 달라진다', () => {
  assert.match(buildSystemPrompt('chat'), /수정할 수 없다/)
  const edit = buildSystemPrompt('edit', { unicode: 'U+4E01', char: '丁' })
  assert.match(edit, /propose_stroke_edits/)
  assert.match(edit, /丁 \(U\+4E01\)/)
})

test('도구 호출 없이 답하면 그대로 돌려준다', async () => {
  const requests = scriptOllama([{ content: '  안녕하세요  ' }])
  const result = await chatWithOllama(parse('안녕'), ws)
  assert.deepEqual(result, { reply: '안녕하세요', proposals: [], toolLog: [], model: 'qwen3.5:9b' })
  assert.deepEqual(requests[0].messages.map((m) => m.role), ['system', 'user'])
})

test('읽기 도구: 모델이 get_character를 부르면 DB의 획 정보를 결과로 돌려준다', async () => {
  const requests = scriptOllama([
    { tool_calls: [{ function: { name: 'get_character', arguments: { char: '丁' } } }] },
    { content: '3획입니다' },
  ])
  const result = await chatWithOllama(parse('丁 획 수는?'), ws)
  assert.equal(result.reply, '3획입니다')
  assert.deepEqual(result.toolLog, ['글자 조회 丁'])
  const toolMessage = requests[1].messages.find((m) => m.role === 'tool')!
  const data = JSON.parse(toolMessage.content!)
  assert.equal(data.unicode, 'U+4E01')
  assert.equal(data.strokes.length, 3)
  assert.equal(data.strokes[0].order, 1)
})

test('읽기 도구: 글자 목록 검색과 없는 글자 처리', async () => {
  const requests = scriptOllama([
    { tool_calls: [{ function: { name: 'list_characters', arguments: JSON.stringify({ q: '정', limit: 5 }) } }, { function: { name: 'get_character', arguments: { char: '龘' } } }] },
    { content: 'ok' },
  ])
  await chatWithOllama(parse('검색'), ws)
  const [list, missing] = requests[1].messages.filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content!))
  assert.equal(list.items[0].char, '丁')
  assert.equal(missing.error, '없는 글자입니다.')
})

test('일반 채팅에서는 수정 제안 도구가 없고, 불러도 거부한다', async () => {
  const requests = scriptOllama([
    { tool_calls: [{ function: { name: 'propose_stroke_edits', arguments: { char: '丁', edits: [{ op: 'reverse', stroke: 1 }] } } }] },
    { content: '못 합니다' },
  ])
  const result = await chatWithOllama(parse('1획 반전', 'chat'), ws)
  const names = (requests[0].tools as { function: { name: string } }[]).map((t) => t.function.name)
  assert.deepEqual(names, ['list_characters', 'get_character'])
  assert.deepEqual(result.proposals, [])
})

test('데이터 수정 채팅: 제안은 모으기만 하고 DB는 바꾸지 않는다', async () => {
  scriptOllama([
    { tool_calls: [{ function: { name: 'propose_stroke_edits', arguments: { char: '丁', edits: [{ op: 'set_radical', stroke: 1, value: 1 }, { op: 'delete', stroke: 9 }] } } }] },
    { content: '제안했습니다' },
  ])
  const result = await chatWithOllama(parse('1획을 부수로', 'edit'), ws)
  assert.deepEqual(result.proposals.map(({ fingerprint, ...rest }) => ({ ...rest, hasFingerprint: fingerprint.length > 0 })), [
    { unicode: 'U+4E01', char: '丁', edits: [{ op: 'set_radical', stroke: 1, value: 1 }], hasFingerprint: true, working: true },
  ])
  assert.equal(ws.getCharacter('U+4E01')!.strokes[0].is_radical, 0)
})

test('도구 호출이 끝없이 이어지면 횟수 상한에서 멈춘다', async () => {
  const requests = scriptOllama([{ tool_calls: [{ function: { name: 'list_characters', arguments: {} } }] }])
  const result = await chatWithOllama(parse('반복'), ws)
  assert.match(result.reply, /너무 많아/)
  assert.deepEqual(requests.at(-1)!.tools, [])
})

test('Ollama 연결 실패·HTTP 오류는 이유를 담은 오류가 된다', async () => {
  globalThis.fetch = (async () => { throw new Error('ECONNREFUSED') }) as typeof fetch
  await assert.rejects(chatWithOllama(parse('안녕'), ws), /연결할 수 없습니다/)
  globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof fetch
  await assert.rejects(chatWithOllama(parse('안녕'), ws), /HTTP 500/)
})

const call = (path: string, body: Record<string, unknown>) =>
  handleApi(ws, { method: 'POST', pathname: path, searchParams: new URLSearchParams(), readBody: async () => body })

test('POST /api/ollama/chat: 정상은 200, 검증 실패는 400', async () => {
  scriptOllama([{ content: 'ok' }])
  const ok = await call('/api/ollama/chat', { messages: [{ role: 'user', content: '안녕' }] })
  assert.equal(ok.status, HTTP_OK)
  assert.equal((ok.body as { reply: string }).reply, 'ok')
  assert.equal((await call('/api/ollama/chat', { messages: [] })).status, HTTP_BAD_REQUEST)
})

test('승인 적용(승인 전 글자): 작업 획에 반영된다', async () => {
  ws.updateStrokes('U+4E19', [bar(100), bar(300)] as never, '초기')
  const edits = [{ op: 'set_radical', stroke: 1, value: 1 }, { op: 'delete', stroke: 2 }]
  const unconfirmed = await call('/api/ollama/apply-edits', { unicode: 'U+4E19', fingerprint: fp('U+4E19'), edits })
  assert.equal(unconfirmed.status, HTTP_BAD_REQUEST)
  assert.match((unconfirmed.body as { error: string }).error, /되돌릴 수 없습니다/)
  assert.equal(ws.getCharacter('U+4E19')!.strokes.length, 2, '확인 없이는 데이터를 바꾸지 않는다')
  const result = await call('/api/ollama/apply-edits', { unicode: 'U+4E19', fingerprint: fp('U+4E19'), confirmWorking: true, edits })
  assert.equal(result.status, HTTP_OK)
  const detail = ws.getCharacter('U+4E19')!
  assert.equal(detail.strokes.length, 1)
  assert.equal(detail.strokes[0].is_radical, 1)
  // 덮어쓰기 전 상태가 되돌릴 수 없는 이력(undoable=0)으로 남는다.
  const db = new DatabaseSync(path.join(root, 'database', 'chusa1817.db'), { readOnly: true })
  const rows = db.prepare(`SELECT action_desc, undoable, stroke_outlines FROM strokes_history WHERE char = ? AND action_desc LIKE 'Ollama 채팅 수정%'`).all(String(detail.char)) as { undoable: number; stroke_outlines: string }[]
  db.close()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].undoable, 0)
  assert.equal(JSON.parse(rows[0].stroke_outlines).length, 2)
})

test('승인 적용(승인된 글자): 이력이 남아 실행 취소할 수 있다', async () => {
  ws.approve('U+4E01')
  const before = ws.getCharacter('U+4E01')!.strokes.length
  const result = await call('/api/ollama/apply-edits', { unicode: 'U+4E01', fingerprint: fp('U+4E01'), edits: [{ op: 'set_radical', stroke: 1, value: 1 }, { op: 'delete', stroke: 3 }] })
  assert.equal(result.status, HTTP_OK)
  const detail = ws.getCharacter('U+4E01')!
  assert.equal(detail.strokes.length, before - 1)
  assert.equal(detail.strokes[0].is_radical, 1)
  ws.undo('U+4E01')
  const restored = ws.getCharacter('U+4E01')!
  assert.equal(restored.strokes.length, before)
  assert.equal(restored.strokes[0].is_radical, 0)
})

test('승인 적용: 잘못된 요청·없는 글자·잠긴 레이어는 거부하고 데이터를 바꾸지 않는다', async () => {
  assert.equal((await call('/api/ollama/apply-edits', { unicode: 'U+4E01', fingerprint: fp('U+4E01'), edits: [{ op: 'delete', stroke: 99 }] })).status, HTTP_BAD_REQUEST)
  assert.equal((await call('/api/ollama/apply-edits', { unicode: 'U+0000', edits: [] })).status, HTTP_BAD_REQUEST)
  ws.updateLayersMeta('U+4E01', [{ id: 'strokes', locked: true }])
  const locked = await call('/api/ollama/apply-edits', { unicode: 'U+4E01', fingerprint: fp('U+4E01'), edits: [{ op: 'reverse', stroke: 1 }] })
  assert.equal(locked.status, HTTP_BAD_REQUEST)
  assert.match((locked.body as { error: string }).error, /잠긴/)
  assert.deepEqual(ws.getCharacter('U+4E01')!.strokes[0].median_points, [[110, 130], [390, 130]])
})

test('승인 적용: 제안을 받은 뒤 획 데이터가 바뀌었거나 지문이 없으면 거부한다', async () => {
  ws.updateLayersMeta('U+4E01', [{ id: 'strokes', locked: false }])
  const stale = fp('U+4E01')
  ws.updateStrokes('U+4E01', [bar(100), bar(300), bar(520)] as never, '다른 편집')
  const detail = ws.getCharacter('U+4E01')!
  assert.notEqual(stale, fp('U+4E01'), '내용이 바뀌면 지문이 달라야 한다(같은 길이라도)')
  const edits = [{ op: 'reverse', stroke: 1 }]
  const changed = await call('/api/ollama/apply-edits', { unicode: 'U+4E01', fingerprint: stale, edits })
  assert.equal(changed.status, HTTP_BAD_REQUEST)
  assert.match((changed.body as { error: string }).error, /바뀌어/)
  assert.equal((await call('/api/ollama/apply-edits', { unicode: 'U+4E01', edits })).status, HTTP_BAD_REQUEST)
  assert.deepEqual(ws.getCharacter('U+4E01')!.strokes[0].median_points, detail.strokes[0].median_points)
})
