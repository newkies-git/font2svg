import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after, afterEach, beforeEach, mock } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { hanjaUrl, naverUrl } from '../server/references.ts'
import { createWorkspace } from '../server/workspace.ts'
import { rectPath, strokeOf, tempDir } from './helpers.ts'

// 네트워크는 쓰지 않는다: 전역 fetch를 가짜로 바꿔 URL별 응답을 정한다. 정하지 않은 URL은 404(Ollama는 연결 실패).
const root = tempDir()
const ws = createWorkspace(root)
const sideDb = new DatabaseSync(path.join(root, 'database', 'chusa1817.db'))
after(() => {
  ws.close()
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
  await ws.applyNaver(unicode, 'append')
  const added = detailOf(unicode)
  assert.equal(added.strokes.length, 4, '추가면 기존 획 뒤에 네이버 획을 붙인다')
  assert.equal(added.origin, 'NAVER')
})

const savedRows = (source: string) => sideDb.prepare('SELECT unicode, found FROM reference_data WHERE source = ? ORDER BY unicode').all(source) as { unicode: string; found: number }[]
const hanjaJson = JSON.stringify({ strokes: [bar(100)], medians: [median(100)] })

test('prefetchReferences: Hanzi를 모두 받은 뒤 네이버를 받아 reference_data에 저장하고, 이미 저장된 글자는 건너뛴다', async () => {
  responses.set(hanjaUrl('丁'), hanjaJson)
  responses.set(naverUrl('丁'), naverSvg(0x4e01, 1))
  failing.add(naverUrl('丙'))
  const [hanja, naver] = await ws.prefetchReferences(undefined, { concurrency: 2 })

  assert.equal(hanja.source, 'MMH')
  assert.equal(hanja.found, 1)
  assert.equal(hanja.missing + hanja.found + hanja.cached, hanja.total)
  assert.deepEqual(hanja.failed, [])
  assert.equal(naver.source, 'NAVER')
  assert.equal(naver.found, 1)
  assert.deepEqual(naver.failed, ['丙'])
  // 받지 못한 글자는 저장하지 않아 다음 실행에서 다시 시도한다.
  assert.equal(savedRows('NAVER').some((row) => row.unicode === 'U+4E19'), false)
  assert.equal(savedRows('MMH').find((row) => row.unicode === 'U+4E01')?.found, 1)
  // 순서: Hanzi 요청이 모두 끝난 뒤에 네이버 요청이 시작된다.
  const lastHanja = calls.map((url) => url.includes('hanzi-writer-data')).lastIndexOf(true)
  const firstNaver = calls.findIndex((url) => url.includes('pstatic.net'))
  assert.ok(lastHanja >= 0 && firstNaver > lastHanja)

  // 다시 실행하면 받지 못한 글자만 요청한다.
  calls.length = 0
  failing.clear()
  const again = await ws.prefetchReferences(undefined, { concurrency: 2 })
  assert.deepEqual(calls, [naverUrl('丙')])
  assert.equal(again[0].cached, again[0].total)
  assert.deepEqual(again[1].failed, [])
})

test('prefetchReferences: retryMissing이면 "없음"으로 저장된 글자를 다시 받는다', async () => {
  const before = savedRows('MMH').filter((row) => row.found === 0).length
  assert.ok(before > 0)
  calls.length = 0
  responses.set(hanjaUrl('丙'), hanjaJson)
  const [summary] = await ws.prefetchReferences(['MMH'], { retryMissing: true })
  assert.equal(calls.length, before)
  assert.equal(summary.found, 1)
  assert.equal(savedRows('MMH').find((row) => row.unicode === 'U+4E19')?.found, 1)
})

const strokeCountOf = (unicode: string) => {
  const row = sideDb.prepare('SELECT stroke_count AS n, last_modified_by AS by FROM characters WHERE unicode = ?').get(unicode) as { n: number; by: string }
  return { n: row.n, by: row.by }
}
const forgetNaver = (unicode: string) => sideDb.prepare("DELETE FROM reference_data WHERE unicode = ? AND source = 'NAVER'").run(unicode)

test('NAVER를 새로 받으면 작업 획이 없는 글자의 획수를 NAVER 기준으로 맞춘다(수정자는 그대로)', async () => {
  const unicode = 'U+5E9A'
  forgetNaver(unicode)
  const before = strokeCountOf(unicode)
  assert.equal(before.n, 0)
  responses.set(naverUrl('庚'), naverSvg(0x5e9a, 3))
  await ws.fetchLayer(unicode, 'naver')
  assert.deepEqual(strokeCountOf(unicode), { n: 3, by: before.by })
})

test('작업 획이 있는 글자는 NAVER를 받아도 획수를 바꾸지 않는다', async () => {
  const unicode = 'U+4E59'
  ws.updateStrokes(unicode, [strokeOf(bar(100), median(100))] as never, '초기')
  const before = strokeCountOf(unicode)
  forgetNaver(unicode)
  responses.set(naverUrl('乙'), naverSvg(0x4e59, 4))
  await ws.fetchLayer(unicode, 'naver')
  assert.deepEqual(strokeCountOf(unicode), before)
  // 작업 획을 승인해 strokes 행이 생겨도 같다.
  ws.approve(unicode)
  const approved = strokeCountOf(unicode)
  forgetNaver(unicode)
  await ws.fetchLayer(unicode, 'naver')
  assert.equal(approved.n, 1)
  assert.equal(strokeCountOf(unicode).n, 1)
})

test('syncStrokeCountsFromNaver: 저장된 NAVER 원본으로 획수를 맞추고, 다시 실행해도 결과가 같다', () => {
  const unicode = 'U+4E19'
  forgetNaver(unicode)
  sideDb.prepare("UPDATE characters SET stroke_count = 9 WHERE unicode = ?").run(unicode)
  sideDb.prepare("INSERT INTO reference_data (unicode, source, source_version, raw_data, found) VALUES (?, 'NAVER', 'test', ?, 1)").run(unicode, naverSvg(0x4e19, 5))
  const by = strokeCountOf(unicode).by
  const first = ws.syncStrokeCountsFromNaver()
  assert.ok(first.updated >= 1)
  assert.deepEqual(strokeCountOf(unicode), { n: 5, by })
  assert.equal(ws.syncStrokeCountsFromNaver().updated, 0)
})
