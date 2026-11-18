import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after, afterEach, beforeEach, mock } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { ACJK_VARIANTS, naverUrl } from '../server/references.ts'
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
