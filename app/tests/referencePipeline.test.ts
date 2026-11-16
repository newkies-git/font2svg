import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after, afterEach, beforeEach, mock } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { ACJK_VARIANTS, hanjaUrl, naverUrl } from '../server/references.ts'
import { getWorkspace } from '../server/workspace.ts'
import { rectPath, strokeOf, tempDir } from './helpers.ts'

// 네트워크는 쓰지 않는다: 전역 fetch를 가짜로 바꿔 URL별 응답을 정한다. 정하지 않은 URL은 404(Ollama는 연결 실패).
const root = tempDir()
const ws = getWorkspace(root)
const sideDb = new DatabaseSync(path.join(root, 'database', 'chusa1817.db'))
after(() => {
  sideDb.close()
  fs.rmSync(root, { recursive: true, force: true })
})

const responses = new Map<string, string>()
const calls: string[] = []
const failing = new Set<string>()
beforeEach(() => {
  responses.clear()
  calls.length = 0
  failing.clear()
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.includes(':11434')) throw new Error('Ollama 꺼짐')
    if (failing.has(url)) throw new Error('네트워크 실패')
    const body = responses.get(url)
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 })
  })
})
afterEach(() => mock.restoreAll())

const bar = (y: number) => rectPath(100, y, 500, y + 60)
const median = (y: number): [number, number][] => [[110, y + 30], [490, y + 30]]

function naverSvg(codePoint: number, count: number): string {
  const id = `U${codePoint.toString(16).toUpperCase()}`
  const paths = Array.from({ length: count }, (_, i) => `<path id="${id}d${i + 1}" d="${bar(100 + i * 100)}"/><path clip-path="url(#${id}c${i + 1})" d="M 110 ${130 + i * 100} L 490 ${130 + i * 100}"/>`).join('')
  return `<svg id="${id}ani"><g transform="scale(1,-1) translate(0, -900)">${paths}</g></svg>`
}

const hanjaJson = (count: number) => JSON.stringify({
  strokes: Array.from({ length: count }, (_, i) => bar(100 + i * 100)),
  medians: Array.from({ length: count }, (_, i) => median(100 + i * 100)),
})

// AnimCJK 데이터 파일(database/graphics*.txt, dictionary*.txt)을 미리 둬서 내려받지 않게 한다. 戊·己만 들어 있다.
fs.mkdirSync(path.join(root, 'database'), { recursive: true })
for (const variant of ACJK_VARIANTS) {
  const entries = variant === 'Ja' ? ['戊', '己'] : []
  fs.writeFileSync(path.join(root, 'database', `graphics${variant}.txt`), entries.map((character) => JSON.stringify({ character, strokes: [bar(100)], medians: [median(100)] })).join('\n') + '\n')
  fs.writeFileSync(path.join(root, 'database', `dictionary${variant}.txt`), entries.map((character) => JSON.stringify({ character, acjk: `${character}` })).join('\n') + '\n')
}

ws.importInitial([
  { 한자: '丁', 음: '정', 구분: '중등' },
  { 한자: '丙', 음: '병', 구분: '중등' },
  { 한자: '乙', 음: '을', 구분: '중등' },
  { 한자: '甲', 음: '갑', 구분: '중등' },
  { 한자: '戊', 음: '무', 구분: '중등' },
  { 한자: '己', 음: '기', 구분: '중등' },
  { 한자: '庚', 음: '경', 구분: '중등' },
  { 한자: '辛', 음: '신', 구분: '중등' },
])
const detailOf = (unicode: string) => ws.getCharacter(unicode)!
const cachedRows = (char: string) => sideDb.prepare(`SELECT source, found FROM reference_data WHERE unicode = ? ORDER BY source`).all(char).map((row) => ({ ...row }))

test('네이버에 있으면 네이버로 가져오고, 다음 호출은 캐시를 쓴다', async () => {
  const unicode = 'U+4E01'
  responses.set(naverUrl('丁'), naverSvg(0x4e01, 2))
  const first = await ws.ensureReference(unicode)
  assert.deepEqual(first, { unicode, source: 'NAVER', fetched: true })
  assert.equal(detailOf(unicode).origin, 'NAVER')
  assert.equal(detailOf(unicode).strokes.length, 2)
  const naverCalls = () => calls.filter((url) => url === naverUrl('丁')).length
  assert.equal(naverCalls(), 1)
  const second = await ws.ensureReference(unicode)
  assert.deepEqual(second, { unicode, source: 'NAVER', fetched: false })
  assert.equal(naverCalls(), 1, '두 번째는 캐시된 원문을 쓴다')
})

test('네이버·AnimCJK에 없으면 Hanzi(MMH)로 가져온다', async () => {
  const unicode = 'U+4E19'
  responses.set(hanjaUrl('丙'), hanjaJson(3))
  const result = await ws.ensureReference(unicode)
  assert.deepEqual(result, { unicode, source: 'MMH', fetched: true })
  assert.equal(detailOf(unicode).strokes.length, 3)
  // 앞선 출처의 없음(AnimCJK·네이버)도 캐시된다.
  assert.deepEqual(cachedRows(unicode), [{ source: 'ACJK', found: 0 }, { source: 'MMH', found: 1 }, { source: 'NAVER', found: 0 }])
})

test('어디에도 없으면 이슈로 올리고 없다는 사실을 캐시한다', async () => {
  const unicode = 'U+4E59'
  const result = await ws.ensureReference(unicode)
  assert.deepEqual(result, { unicode, source: 'NONE', fetched: false })
  assert.equal(detailOf(unicode).issue_status, 'OPEN')
  assert.equal(detailOf(unicode).strokes.length, 0)
  const rows = cachedRows(unicode)
  assert.ok(rows.length > 0 && rows.every((row) => row.found === 0))
  calls.length = 0
  await ws.ensureReference(unicode)
  assert.equal(calls.filter((url) => url === naverUrl('乙')).length, 0, '없음도 캐시돼 다시 묻지 않는다')
})

test('네트워크 실패는 없는 글자로 기록하지 않는다', async () => {
  const unicode = 'U+5E9A'
  failing.add(naverUrl('庚'))
  failing.add(hanjaUrl('庚'))
  const result = await ws.ensureReference(unicode)
  assert.equal(result.source, 'NONE')
  assert.deepEqual(cachedRows(unicode), [{ source: 'ACJK', found: 0 }], '네트워크가 실패한 출처(네이버·MMH)는 캐시하지 않아 다음에 다시 시도한다')
})

test('applyNaver: 네이버에 없으면 아무것도 바꾸지 않고 던진다', async () => {
  const unicode = 'U+7532'
  await assert.rejects(ws.applyNaver(unicode), /네이버 한자사전에서/)
  assert.equal(detailOf(unicode).strokes.length, 0)
})

test('applyNaver: 기존 획을 네이버 획순으로 바꾸고 이전 상태를 이력에 남긴다', async () => {
  const unicode = 'U+8F9B'
  ws.updateStrokes(unicode, [strokeOf(bar(100), median(100))] as never, '초기')
  // 작업 데이터 → 승인해 strokes 행을 만든다.
  ws.approve(unicode)
  responses.set(naverUrl('辛'), naverSvg(0x8f9b, 2))
  await ws.applyNaver(unicode)
  const detail = detailOf(unicode)
  assert.equal(detail.origin, 'NAVER')
  assert.equal(detail.strokes.length, 2)
  assert.ok(detail.history_count > 0)
})

test('applyAcjkBatch: 교체·사람이 고친 글자·이미 적용·AnimCJK에 없음을 구분해 센다', async () => {
  // 己는 사람이 고친 상태로 만든다(작업 데이터의 마지막 수정자가 사용자).
  ws.updateStrokes('U+5DF1', [strokeOf(bar(300), median(300))] as never, '수작업')
  const first = await ws.applyAcjkBatch('', 200)
  assert.equal(first.counts.REPLACED, 1)
  assert.equal(first.counts.EDITED, 1)
  assert.deepEqual(first.edited, ['己'])
  assert.equal(first.counts.NOT_IN_ACJK, first.processed - 2 - first.counts.ALREADY)
  assert.equal(first.next, null)
  assert.equal(detailOf('U+620A').origin, 'ACJK')
  const second = await ws.applyAcjkBatch('', 200)
  assert.equal(second.counts.REPLACED, 0)
  assert.equal(second.counts.ALREADY, 1)
})

test('applyAcjkBatch: limit만큼만 처리하고 다음 위치를 돌려준다', async () => {
  const page = await ws.applyAcjkBatch('', 2)
  assert.equal(page.processed, 2)
  assert.ok(page.next)
  const rest = await ws.applyAcjkBatch(page.next!, 200)
  assert.equal(rest.next, null)
})

test('syncMissing: 획도 작업 데이터도 없는 글자만 limit만큼 시도한다', async () => {
  const result = await ws.syncMissing(1)
  assert.equal(result.tried, 1)
})
