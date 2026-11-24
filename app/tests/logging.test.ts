import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test, { beforeEach, mock } from 'node:test'
import { readJsonBody } from '../server/http.ts'
import { parseHanja } from '../server/references.ts'
import { WARN_ONCE_LIMIT } from '../shared/constants.ts'
import { resetWarnings, warnOnce } from '../shared/log.ts'
import { recoverMedian } from '../shared/strokeCut.ts'
import { recomputeStrokeWidth } from '../shared/vectorEdit.ts'

let warn: ReturnType<typeof mock.method>

// 문자열로 바꾸는 순간 던지는 값: 윤곽 경로를 해석하는 코드에서 예상 밖의 예외를 일으킨다.
const explosive = (): string => ({ trim: () => 'M 0 0 L 1 1 Z', toString() { throw new TypeError('예상 밖의 오류') } }) as unknown as string

beforeEach(() => {
  mock.restoreAll()
  resetWarnings()
  warn = mock.method(console, 'warn', () => {})
})

const warnings = () => warn.mock.calls.map((call) => String(call.arguments[0]))

test('warnOnce: 같은 범위·메시지는 한 번만 기록한다', () => {
  warnOnce('범위', new Error('문제'))
  warnOnce('범위', new Error('문제'))
  warnOnce('범위', '문제')
  warnOnce('다른 범위', new Error('문제'))
  warnOnce('범위', new Error('다른 문제'))
  assert.deepEqual(warnings(), ['[범위] 문제', '[다른 범위] 문제', '[범위] 다른 문제'])
})

test('warnOnce: 서로 다른 경고가 상한을 넘으면 더 기록하지 않고 한 번만 알린다', () => {
  for (let i = 0; i < WARN_ONCE_LIMIT + 20; i++) warnOnce('폭주', `메시지 ${i}`)
  assert.equal(warnings().length, WARN_ONCE_LIMIT + 1)
  assert.match(warnings()[WARN_ONCE_LIMIT], /넘어 이후 경고는 기록하지 않습니다/)
})

test('recoverMedian: 입력 모양 탓의 예상된 실패는 조용히 대체값을 쓴다', () => {
  const result = recoverMedian('')
  assert.deepEqual(result.median, [])
  assert.equal(warnings().length, 0)
})

test('recoverMedian: 예상 밖의 오류는 대체값을 쓰되 한 번 알린다', () => {
  assert.deepEqual(recoverMedian(explosive()).median, [])
  assert.deepEqual(recoverMedian(explosive()).median, [])
  assert.equal(warnings().length, 1)
  assert.match(warnings()[0], /^\[recoverMedian\] 예상 밖의 오류/)
})

test('recomputeStrokeWidth: 계산이 실패하면 기존 폭을 돌려주고 한 번 알린다', () => {
  assert.equal(recomputeStrokeWidth(explosive(), [[0, 0], [10, 10]], 77), 77)
  assert.equal(recomputeStrokeWidth(explosive(), [[0, 0], [10, 10]], 77), 77)
  assert.equal(warnings().length, 1)
  assert.match(warnings()[0], /^\[recomputeStrokeWidth\]/)
})

test('parseHanja: 해석하지 못하는 원문은 null이고 한 번 알린다', () => {
  assert.equal(parseHanja('{깨진 JSON'), null)
  assert.equal(parseHanja('{깨진 JSON'), null)
  assert.equal(warnings().length, 1)
  assert.match(warnings()[0], /^\[parseHanja\]/)
})

test('readJsonBody: 잘못된 JSON 오류에 원인(cause)을 붙인다', async () => {
  await assert.rejects(
    readJsonBody(Readable.from([Buffer.from('{bad')])),
    (error: Error) => error.message === 'JSON 형식이 아닙니다.' && error.cause instanceof SyntaxError,
  )
})
