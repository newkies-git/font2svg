import assert from 'node:assert/strict'
import test, { afterEach, mock } from 'node:test'
import { listOllamaStatus, resolveOllamaBaseUrl } from '../server/ollamaClient.ts'

afterEach(() => mock.restoreAll())

const stubOllama = (response: Response | Error) => mock.method(globalThis, 'fetch', async () => { if (response instanceof Error) throw response; return response })

test('resolveOllamaBaseUrl: loopback OLLAMA_HOST는 허용하고 비-loopback·잘못된 주소는 거부한다', () => {
  assert.equal(resolveOllamaBaseUrl(undefined), 'http://127.0.0.1:11434')
  assert.equal(resolveOllamaBaseUrl('  '), 'http://127.0.0.1:11434')
  assert.equal(resolveOllamaBaseUrl('127.0.0.1:11435'), 'http://127.0.0.1:11435')
  assert.equal(resolveOllamaBaseUrl('localhost'), 'http://localhost:11434')
  assert.equal(resolveOllamaBaseUrl('http://[::1]:11434/'), 'http://[::1]:11434')

  for (const invalid of [
    '0.0.0.0:11434',
    'http://192.168.0.10:11434',
    'https://example.com',
    'http://user:pass@127.0.0.1:11434',
    'ftp://127.0.0.1:11434',
  ]) {
    assert.throws(() => resolveOllamaBaseUrl(invalid), /loopback|OLLAMA_HOST/, invalid)
  }
})

test('listOllamaStatus: OLLAMA_HOST가 loopback이면 해당 포트로 조회하고, 비-loopback이면 fetch 없이 차단한다', async () => {
  const prev = process.env.OLLAMA_HOST
  try {
    process.env.OLLAMA_HOST = 'localhost:11435'
    const okFetch = stubOllama(new Response(JSON.stringify({ models: [{ name: 'qwen3.5:9b' }] }), { status: 200 }))
    const ok = await listOllamaStatus()
    assert.equal(ok.connected, true)
    assert.equal(ok.url, 'http://localhost:11435')
    assert.equal(String(okFetch.mock.calls[0].arguments[0]), 'http://localhost:11435/api/tags')

    mock.restoreAll()
    mock.method(console, 'warn', () => {})
    process.env.OLLAMA_HOST = '0.0.0.0:11434'
    const blockedFetch = stubOllama(new Response('{}', { status: 200 }))
    const blocked = await listOllamaStatus()
    assert.equal(blocked.connected, false)
    assert.equal(blockedFetch.mock.calls.length, 0)
    assert.match(blocked.error ?? '', /loopback/)
  } finally {
    if (prev === undefined) delete process.env.OLLAMA_HOST
    else process.env.OLLAMA_HOST = prev
  }
})
