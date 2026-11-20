import assert from 'node:assert/strict'
import test, { afterEach, beforeEach, mock } from 'node:test'
import { askOllama, IDS_LAYOUTS, listOllamaStatus, parseIds, parseIdsFile, resolveOllamaBaseUrl } from '../server/ids.ts'

test('IDS 파싱: 낱글자와 이항·삼항·중첩 구조를 트리로 읽는다', () => {
  assert.deepEqual(parseIds('木'), { leaf: '木' })
  assert.deepEqual(parseIds('⿰木木'), { op: '⿰', children: [{ leaf: '木' }, { leaf: '木' }] })
  assert.deepEqual(parseIds('⿲彳亍丨'), { op: '⿲', children: [{ leaf: '彳' }, { leaf: '亍' }, { leaf: '丨' }] })
  assert.deepEqual(parseIds('⿱日⿰月日'), { op: '⿱', children: [{ leaf: '日' }, { op: '⿰', children: [{ leaf: '月' }, { leaf: '日' }] }] })
})

test('IDS 파싱: 부품이 모자라거나 남거나 지원 안 하는 표기면 null', () => {
  assert.equal(parseIds(''), null)
  assert.equal(parseIds('⿰木'), null, '부품 부족')
  assert.equal(parseIds('⿰木木火'), null, '남는 문자')
  assert.equal(parseIds('⿰木{1}'), null, '조합 표기')
  assert.equal(parseIds('&CDP-8B39;'), null, '개체 참조')
  assert.equal(parseIds('⿾木木'), null, '모르는 연산자(U+2FFE)는 낱글자로 보지 않는다')
})

test('연산자마다 배치 칸 수가 맞고 칸은 0~1 안에 있다', () => {
  for (const [op, boxes] of Object.entries(IDS_LAYOUTS)) {
    assert.ok(boxes.length === 2 || boxes.length === 3, op)
    for (const [left, bottom, right, top] of boxes) {
      assert.ok(left >= 0 && bottom >= 0 && right <= 1 && top <= 1 && left < right && bottom < top, `${op} ${[left, bottom, right, top]}`)
    }
  }
})

test('IDS.TXT 파싱: 주석·빈 줄·BOM·동치 표기를 건너뛰고 한국 표기를 먼저 둔다', () => {
  const text = [
    '﻿# 설명',
    '',
    'U+6797\t林\t^⿰木木$(GHTJKV)',
    'U+660C\t昌\t^⿱日日$(G)\t^⿱日曰$(JK)',
    'U+0000\t*\t*⿰木木',
    'U+4E00\t一\t^一$(GHTJKV)',
    '깨진 줄',
    'U+9999\t無\t설명만 있는 항목',
  ].join('\r\n')
  const index = parseIdsFile(text)
  assert.deepEqual(index.get('林'), ['⿰木木'])
  assert.deepEqual(index.get('昌'), ['⿱日曰', '⿱日日'], 'K가 붙은 표기가 앞')
  assert.deepEqual(index.get('一'), ['一'])
  assert.equal(index.has('無'), false)
  assert.equal(index.has('*'), false)
})

beforeEach(() => { mock.method(console, 'warn', () => {}) })
afterEach(() => mock.restoreAll())

const stubOllama = (response: Response | Error) => mock.method(globalThis, 'fetch', async () => { if (response instanceof Error) throw response; return response })
const ollamaBody = (inner: unknown) => new Response(JSON.stringify({ response: typeof inner === 'string' ? inner : JSON.stringify(inner) }), { status: 200 })

test('Ollama: 응답의 ids 문자열을 돌려준다', async () => {
  const fetchMock = stubOllama(ollamaBody({ ids: '⿰木木' }))
  assert.equal(await askOllama('林'), '⿰木木')
  const [url, init] = fetchMock.mock.calls[0].arguments as [string, RequestInit]
  assert.match(String(url), /:11434\/api\/generate$/)
  const body = JSON.parse(String(init.body)) as { stream: boolean; prompt: string; options: { temperature: number } }
  assert.equal(body.stream, false)
  assert.equal(body.options.temperature, 0, '같은 입력엔 같은 답이 나오게 고정한다')
  assert.ok(body.prompt.includes('林'))
})

test('Ollama: 응답이 이상하거나 꺼져 있으면 null(IDS 없이 계속)', async () => {
  stubOllama(new Response('server error', { status: 500 }))
  assert.equal(await askOllama('林'), null)
  mock.restoreAll()
  mock.method(console, 'warn', () => {})
  stubOllama(ollamaBody('JSON이 아님'))
  assert.equal(await askOllama('林'), null)
  mock.restoreAll()
  mock.method(console, 'warn', () => {})
  stubOllama(ollamaBody({ ids: 5 }))
  assert.equal(await askOllama('林'), null)
  mock.restoreAll()
  mock.method(console, 'warn', () => {})
  stubOllama(new Error('connect ECONNREFUSED'))
  assert.equal(await askOllama('林'), null)
})

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
