import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after, afterEach, beforeEach, mock } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { naverUrl } from '../server/references.ts'
import { createWorkspace } from '../server/workspace.ts'
import { drawRect, rectPath, strokeOf, tempDir, writeTestFont } from './helpers.ts'

const root = tempDir()
// 궁서체 시험 폰트: 一만 있다(가로 막대). 작업 공간이 처음 폰트를 읽기 전에 둔다.
writeTestFont(path.join(root, 'app', 'fonts', 'Gungseouche.ttf'), [{ char: '一', draw: (p) => drawRect(p, 100, 300, 900, 400) }])
const ws = createWorkspace(root)
const sideDb = new DatabaseSync(path.join(root, 'database', 'chusa1817.db'))
after(() => {
  ws.close()
  sideDb.close()
  fs.rmSync(root, { recursive: true, force: true })
})

const responses = new Map<string, string>()
beforeEach(() => {
  responses.clear()
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const body = responses.get(String(input))
    return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200 })
  })
})
afterEach(() => mock.restoreAll())

ws.importInitial([
  { 한자: '一', 음: '일', 구분: '초등' },
  { 한자: '二', 음: '이', 구분: '초등' },
  { 한자: '三', 음: '삼', 구분: '초등' },
  { 한자: '四', 음: '사', 구분: '초등' },
  { 한자: '五', 음: '오', 구분: '초등' },
])
const bar = rectPath(100, 400, 900, 520)
const barMedian: [number, number][] = [[150, 460], [870, 460]]

// 외부 레퍼런스 원문을 캐시에 미리 넣어 네트워크 없이 레이어에 나타나게 한다.
function cacheReference(unicode: string, source: 'MMH' | 'NAVER', raw: unknown) {
  sideDb.prepare(`INSERT INTO reference_data (unicode, source, source_version, source_url, raw_data, raw_sha256, found) VALUES (?, ?, 'test', 'http://example/test', ?, 'x', 1)`)
    .run(unicode, source, JSON.stringify(raw))
}
const barGlyph = { strokes: [bar], medians: [barMedian] }
const strokeCountOf = (unicode: string) => (sideDb.prepare('SELECT stroke_count AS n FROM characters WHERE unicode = ?').get(unicode) as { n: number }).n

test('글자 목록: 글자·음·유니코드(대소문자 무시)로 거르고 없으면 빈 배열', () => {
  assert.equal(ws.listCharacters('').length, 5)
  assert.deepEqual(ws.listCharacters(' 삼 ').map((row) => row.char), ['三'])
  assert.deepEqual(ws.listCharacters('u+4e8c').map((row) => row.char), ['二'])
  assert.deepEqual(ws.listCharacters('四').map((row) => row.unicode), ['U+56DB'])
  assert.deepEqual(ws.listCharacters('없는말'), [])
})

test('SVG 가져오기: 획이 없는 글자는 작업 데이터로 가져오고, 획이 있으면 거부한다', () => {
  const svg = `<svg id="z19977" viewBox="0 0 1024 1024"><path id="z19977d1" d="M 100 800 H 300 V 700 L 100 700 z"/><path pathLength="3333" clip-path="url(#z19977c1)" d="M 110 750 L 290 750"/></svg>`
  const detail = ws.importSvg('U+4E09', svg)!
  assert.equal(detail.working, true)
  assert.equal(detail.strokes.length, 1)
  ws.approve('U+4E09')
  assert.throws(() => ws.importSvg('U+4E09', svg), /이미 있는 글자/)
  // 승인은 획을 strokes로 옮기고 작업 데이터를 지우고 글자의 획수를 맞추며 issues를 '승인됨'으로 남긴다.
  assert.equal(strokeCountOf('U+4E09'), 1)
  assert.equal((sideDb.prepare(`SELECT COUNT(*) AS n FROM working_data WHERE char = '三'`).get() as { n: number }).n, 0)
  assert.equal(ws.getCharacter('U+4E09')!.issue_status, 'APPROVED')
})

test('외부 수신: 네이버에 있으면 레이어를 표시하고, 없거나 지원 안 하는 레이어면 던진다', async () => {
  await assert.rejects(ws.fetchLayer('U+56DB', 'naver'), /네이버 한자사전에서/)
  responses.set(naverUrl('四'), `<svg id="U56DBani"><g transform="scale(1,-1) translate(0, -900)"><path id="U56DBd1" d="${bar}"/><path clip-path="url(#U56DBc1)" d="M 150 460 L 870 460"/></g></svg>`)
  // 앞 호출이 '없음'을 캐시했어도 fetchLayer는 네이버의 없음 캐시를 지우고 다시 묻는다.
  const detail = (await ws.fetchLayer('U+56DB', 'naver'))!
  const layer = detail.layers.find((item) => item.id === 'naver')!
  assert.equal(layer.available, true)
  assert.equal(layer.visible, true)
  await assert.rejects(ws.fetchLayer('U+56DB', 'strokes'), /외부 수신을 지원하지 않는/)
  await assert.rejects(ws.fetchLayer('U+56DB', 'constructor'), /외부 수신을 지원하지 않는/, '객체 기본 속성 이름이 수신 방법으로 잡히지 않는다')
  await assert.rejects(ws.fetchLayer('U+56DB', 'mmh'), /Hanzi\(MMH\)에서/)
  await assert.rejects(ws.fetchLayer('U+56DB', 'acjk'), /AnimCJK에서/)
})

test('레이어를 작업 획에 적용(direct): 레퍼런스 종류가 출처가 되고 레이어가 없으면 던진다', () => {
  const unicode = 'U+4E8C'
  cacheReference(unicode, 'MMH', barGlyph)
  assert.throws(() => ws.applyLayerToStrokes(unicode, 'acjk'), /적용할 획 데이터가 없는/)
  const detail = ws.applyLayerToStrokes(unicode, 'mmh')!
  assert.equal(detail.origin, 'MMH')
  assert.equal(detail.strokes.length, 1)
  assert.equal(detail.strokes[0].outline_path, bar)
  assert.equal(strokeCountOf(unicode), 1, '레퍼런스를 적용하면 글자의 획수도 맞춘다')
})

test('레이어를 작업 획에 적용(fit_font): 궁서체 윤곽으로 나누고, 궁서체가 없으면 던진다', () => {
  cacheReference('U+4E00', 'MMH', barGlyph)
  const detail = ws.applyLayerToStrokes('U+4E00', 'mmh', 'fit_font')!
  assert.equal(detail.origin, 'MMH')
  assert.ok(detail.strokes.length >= 1)
  assert.ok(detail.layers.find((layer) => layer.id === 'font')!.paths.length > 0)
  // 四는 폰트에 없고 저장된 윤곽도 없다(앞 테스트에서 네이버 레이어만 생겼다).
  assert.throws(() => ws.applyLayerToStrokes('U+56DB', 'naver', 'fit_font'), /궁서체 윤곽이 없어/)
})

test('중심선 재분할: 입력을 검증하고 궁서체 윤곽을 나눈 결과를 준다', () => {
  const result = ws.resegmentLayer('U+4E00', [barMedian])
  assert.equal(result.outlines.length, 1)
  assert.equal(result.medians.length, 1)
  assert.equal(result.widths.length, 1)
  assert.throws(() => ws.resegmentLayer('U+4E00', []), /비어 있습니다/)
  assert.throws(() => ws.resegmentLayer('U+4E00', [[[1, 1]]]), /2점 이상/)
  assert.throws(() => ws.resegmentLayer('U+56DB', [barMedian]), /궁서체 윤곽이 없어/)
  assert.throws(() => ws.resegmentLayer('U+9999', [barMedian]), /등록되지 않은/)
})

test('사용자 레이어: 복제·적용(MANUAL)·삭제, 기본 레이어는 삭제 불가', () => {
  const unicode = 'U+4E94'
  ws.updateStrokes(unicode, [strokeOf(bar, barMedian)] as never, '초기')
  const { createdId, detail } = ws.duplicateLayer(unicode, 'strokes', '복제본')
  assert.ok(detail!.layers.some((layer) => layer.id === createdId && layer.kind === 'CUSTOM'))
  ws.saveLayer(unicode, createdId, { strokes: [strokeOf(bar, barMedian), strokeOf(rectPath(100, 600, 900, 700), [[150, 650], [870, 650]])] })
  const applied = ws.applyLayerToStrokes(unicode, createdId)!
  assert.equal(applied.strokes.length, 2)
  assert.throws(() => ws.deleteLayer(unicode, 'strokes'), /삭제할 수 없습니다/)
  const after = ws.deleteLayer(unicode, createdId)!
  assert.ok(!after.layers.some((layer) => layer.id === createdId))
  assert.throws(() => ws.duplicateLayer('U+9999'), /등록되지 않은/)
})

test('새 사용자 레이어의 기본 불투명도는 상수를 따른다', async () => {
  const { DEFAULT_CUSTOM_LAYER_OPACITY } = await import('../shared/constants.ts')
  const { createdId, detail } = ws.duplicateLayer('U+4E94', 'strokes')
  assert.equal(detail!.layers.find((layer) => layer.id === createdId)!.opacity, DEFAULT_CUSTOM_LAYER_OPACITY)
})
