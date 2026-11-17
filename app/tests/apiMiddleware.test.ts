import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test, { beforeEach, mock } from 'node:test'
import { createApiMiddleware } from '../server/apiMiddleware.ts'
import { HTTP_BAD_REQUEST, HTTP_FORBIDDEN, HTTP_INTERNAL_ERROR, HTTP_OK } from '../server/http.ts'
import type { Workspace } from '../server/workspace.ts'

const LOOPBACK = '127.0.0.1'

// 예상하지 못한 오류 경로는 경고를 남기므로 시험 출력에서 막는다.
beforeEach(() => mock.method(console, 'warn', () => {}))

// 호출 기록만 남기는 가짜 작업 공간
function fakeWorkspace() {
  const calls: { name: string; args: unknown[] }[] = []
  const ws = new Proxy({}, {
    get: (_target, name: string) => (...args: unknown[]) => {
      calls.push({ name, args })
      return { called: name }
    },
  }) as unknown as Workspace
  return { ws, calls }
}

// 요청: 비동기로 읽을 수 있는 본문과 연결 주소를 가진다.
function fakeRequest(method: string, url: string, options: { address?: string | undefined; body?: string } = {}) {
  const address = 'address' in options ? options.address : LOOPBACK
  const chunks = options.body === undefined ? [] : [Buffer.from(options.body)]
  return Object.assign(
    { [Symbol.asyncIterator]: async function* () { yield* chunks } },
    { method, url, socket: { remoteAddress: address } },
  ) as unknown as IncomingMessage
}

function fakeResponse() {
  const sent = { status: 0, headers: {} as Record<string, string>, body: '' }
  let finish: () => void = () => {}
  const finished = new Promise<void>((resolve) => { finish = resolve })
  const res = {
    headersSent: false,
    set statusCode(value: number) { sent.status = value },
    setHeader: (name: string, value: string) => { sent.headers[name] = value },
    end: (text?: string) => { sent.body = text ?? ''; finish() },
  } as unknown as ServerResponse
  return { res, sent, finished, finish }
}

// 미들웨어는 Promise를 돌려주지 않으므로, 응답이 끝나거나 next가 불릴 때까지 기다린다.
async function run(ws: Workspace, req: IncomingMessage, next: () => void = () => {}) {
  const { res, sent, finished, finish } = fakeResponse()
  let nextCalled = false
  createApiMiddleware(ws)(req, res, () => {
    nextCalled = true
    try { next() } finally { finish() }
  })
  await finished
  return { sent, nextCalled }
}

test('/api/ 밖의 경로는 건드리지 않고 다음 미들웨어로 넘긴다', async () => {
  const { ws, calls } = fakeWorkspace()
  const { sent, nextCalled } = await run(ws, fakeRequest('GET', '/index.html'))
  assert.equal(nextCalled, true)
  assert.equal(sent.status, 0)
  assert.equal(calls.length, 0)
})

test('같은 컴퓨터가 아닌 주소에서 온 API 요청은 403이고 작업 공간을 부르지 않는다', async () => {
  for (const address of ['192.168.0.5', '10.0.0.1', undefined]) {
    const { ws, calls } = fakeWorkspace()
    const { sent, nextCalled } = await run(ws, fakeRequest('GET', '/api/characters', { address }))
    assert.equal(sent.status, HTTP_FORBIDDEN, String(address))
    assert.deepEqual(JSON.parse(sent.body), { error: '이 API는 같은 컴퓨터에서만 쓸 수 있습니다.' })
    assert.equal(nextCalled, false)
    assert.equal(calls.length, 0)
  }
})

test('IPv4·IPv6 루프백 주소는 모두 받는다', async () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const { ws, calls } = fakeWorkspace()
    const { sent } = await run(ws, fakeRequest('GET', '/api/radicals', { address }))
    assert.equal(sent.status, HTTP_OK, address)
    assert.equal(calls[0].name, 'listRadicals')
  }
})

test('응답은 상태 코드와 JSON 본문, UTF-8 JSON 헤더로 보낸다', async () => {
  const { ws, calls } = fakeWorkspace()
  const { sent } = await run(ws, fakeRequest('GET', '/api/characters?q=%E4%B8%81'))
  assert.equal(sent.status, HTTP_OK)
  assert.equal(sent.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(sent.body), { called: 'listCharacters' })
  assert.deepEqual(calls[0].args, ['丁'], '쿼리 문자열의 q를 넘긴다')
})

test('JSON 본문은 읽어서 핸들러에 넘기고, 잘못된 JSON은 400으로 알린다', async () => {
  const good = fakeWorkspace()
  const ok = await run(good.ws, fakeRequest('POST', '/api/import', { body: JSON.stringify({ entries: [{ 한자: '丁' }] }) }))
  assert.equal(ok.sent.status, HTTP_OK)
  assert.deepEqual(good.calls[0], { name: 'importInitial', args: [[{ 한자: '丁' }]] })

  const bad = fakeWorkspace()
  const failed = await run(bad.ws, fakeRequest('POST', '/api/import', { body: '{깨진' }))
  assert.equal(failed.sent.status, HTTP_BAD_REQUEST)
  assert.deepEqual(JSON.parse(failed.sent.body), { error: 'JSON 형식이 아닙니다.' })
  assert.equal(bad.calls.length, 0)
})

test('읽을 수 없는 주소는 처리되지 않은 오류 대신 400으로 알린다', async () => {
  const { ws, calls } = fakeWorkspace()
  for (const url of ['//', '//host:bad']) {
    const { sent, nextCalled } = await run(ws, fakeRequest('GET', url))
    assert.equal(sent.status, HTTP_BAD_REQUEST, url)
    assert.deepEqual(JSON.parse(sent.body), { error: '요청 주소가 올바르지 않습니다.' })
    assert.equal(nextCalled, false)
  }
  assert.equal(calls.length, 0)
})

test('예상하지 못한 오류는 500으로 알리고 처리되지 않은 rejection이 되지 않는다', async () => {
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  try {
    const { ws } = fakeWorkspace()
    const { sent } = await run(ws, fakeRequest('GET', '/index.html'), () => { throw new Error('다음 미들웨어 실패') })
    assert.equal(sent.status, HTTP_INTERNAL_ERROR)
    assert.deepEqual(JSON.parse(sent.body), { error: '요청을 처리하지 못했습니다.' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})
