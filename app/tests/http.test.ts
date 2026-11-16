import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import { isLoopbackAddress, readJsonBody } from '../server/http.ts'

const stream = (...parts: string[]) => Readable.from(parts.map((part) => Buffer.from(part)))

test('본문 JSON 읽기: 여러 조각을 합친다', async () => {
  assert.deepEqual(await readJsonBody(stream('{"a":', '1}')), { a: 1 })
})

test('본문이 없으면 빈 객체', async () => {
  assert.deepEqual(await readJsonBody(stream()), {})
})

test('JSON이 아니면 오류', async () => {
  await assert.rejects(readJsonBody(stream('{bad')), { message: 'JSON 형식이 아닙니다.' })
})

test('상한을 넘으면 오류', async () => {
  await assert.rejects(readJsonBody(stream('{"a":"', 'x'.repeat(50), '"}'), 20), { message: '요청 본문이 너무 큽니다.' })
})

test('루프백 주소만 허용', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.0.10'), false)
  assert.equal(isLoopbackAddress(undefined), false)
})
