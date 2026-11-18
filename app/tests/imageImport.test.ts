import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { animatedSvg } from '../server/animSvg.ts'
import { parseImageImport } from '../server/imageRequests.ts'
import { createWorkspace } from '../server/workspace.ts'
import { CANVAS } from '../shared/constants.ts'
import { traceImageMask } from '../shared/imageTrace.ts'
import { pathBBox } from '../shared/paths.ts'
import { tempDir } from './helpers.ts'

const SIZE = 200
const SHA = 'a'.repeat(64)

function maskWith(draw: (x: number, y: number) => boolean): Uint8Array {
  const mask = new Uint8Array(SIZE * SIZE)
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) mask[y * SIZE + x] = draw(x, y) ? 1 : 0
  return mask
}
const inBox = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) => x >= x0 && x < x1 && y >= y0 && y < y1

// 이미지에서 뽑은 윤곽: 십자(덩어리 1개), 가로 막대(덩어리 1개)
const cross = traceImageMask(maskWith((x, y) => inBox(x, y, 20, 90, 180, 110) || inBox(x, y, 90, 20, 110, 180)), SIZE, SIZE).contours
const bar = traceImageMask(maskWith((x, y) => inBox(x, y, 20, 90, 180, 110)), SIZE, SIZE).contours

const imageOf = (overrides: Record<string, unknown> = {}) => ({
  name: 'scan.png', mime: 'image/png', sha256: SHA, width: SIZE, height: SIZE, threshold: 128, invert: false, ...overrides,
})
const requestOf = (contours: string[], extra: Record<string, unknown> = {}) => ({ contours, image: imageOf(), ...extra })

test('요청 검사: 올바른 요청은 통과하고 파일 이름은 이름만 남긴다', () => {
  const parsed = parseImageImport({ contours: bar, image: imageOf({ name: 'C:\\scans\\한자/一.png' }) })
  assert.equal(parsed.image.name, '一.png')
  assert.equal(parsed.split, 'AUTO')
  assert.equal(parseImageImport({ contours: bar, image: imageOf(), split: 'COMPONENTS' }).split, 'COMPONENTS')
})

test('요청 검사: 잘못된 윤곽·이미지 정보·방식은 거부한다', () => {
  const bad = (raw: unknown, pattern: RegExp) => assert.throws(() => parseImageImport(raw), pattern)
  bad(null, /윤곽이 없습니다/)
  bad({ contours: [], image: imageOf() }, /윤곽이 없습니다/)
  bad({ contours: ['M0 0L1 1'], image: imageOf() }, /경로가 올바르지 않습니다/)
  bad({ contours: ['<script>'], image: imageOf() }, /경로가 올바르지 않습니다/)
  bad({ contours: [`M0 0L${CANVAS + 1} 0L0 10Z`], image: imageOf() }, /벗어났습니다/)
  bad({ contours: bar, image: imageOf({ mime: 'image/gif' }) }, /지원하지 않는 이미지 형식/)
  bad({ contours: bar, image: imageOf({ sha256: 'xyz' }) }, /SHA-256/)
  bad({ contours: bar, image: imageOf({ threshold: 300 }) }, /이진화 경계/)
  bad({ contours: bar, image: imageOf({ width: 0 }) }, /이미지 너비/)
  bad({ contours: bar, image: imageOf({ invert: 'yes' }) }, /반전 여부/)
  bad({ contours: bar, image: imageOf(), split: 'MAGIC' }, /획 나누기 방식/)
})

const root = tempDir()
const ws = createWorkspace(root)
const sideDb = new DatabaseSync(path.join(root, 'database', 'chusa1817.db'))
after(() => {
  ws.close()
  sideDb.close()
  fs.rmSync(root, { recursive: true, force: true })
})
ws.importInitial([
  { 한자: '一', 음: '일', 구분: '초등' },
  { 한자: '十', 음: '십', 구분: '초등' },
  { 한자: '二', 음: '이', 구분: '초등' },
])
const conversionsOf = (unicode: string) => ws.listConversions(unicode)

test('획이 없는 글자: 덩어리를 획으로 보고 승인 전 작업 데이터로 저장하며 변환 이력을 남긴다', () => {
  const detail = ws.importImage('U+4E00', requestOf(bar))!
  assert.equal(detail.working, true)
  assert.equal(detail.strokes.length, 1)
  assert.equal(detail.origin, 'MANUAL')
  assert.equal(detail.origin_url, `image:sha256:${SHA}`)
  assert.equal(detail.issue_status, 'DRAFT')
  assert.equal(detail.issue_reason, '이미지 변환 초안')

  const [record] = conversionsOf('U+4E00')
  assert.equal(record.kind, 'IMAGE_TO_SVG')
  assert.equal(record.source_name, 'scan.png')
  assert.equal(record.source_sha256, SHA)
  assert.equal(record.source_width, SIZE)
  assert.equal(record.threshold, 128)
  assert.equal(record.invert, 0)
  assert.equal(record.mode, 'COMPONENTS')
  assert.equal(record.destination, 'WORKING')
  assert.equal(record.stroke_count, 1)
  assert.equal(record.created_by, 'user')
  assert.match(record.result_svg, /^<svg id="z19968" class="acjk"/)
  assert.match(record.result_svg, /id="z19968d1"/)
})

test('변환 결과 SVG는 컴파일이 만드는 것과 같은 애니메이션 SVG이고, SVG 가져오기가 같은 좌표로 다시 읽는다', () => {
  const [record] = conversionsOf('U+4E00')
  const saved = ws.getCharacter('U+4E00')!.strokes[0]
  assert.equal(record.result_svg, animatedSvg('U+4E00', [saved.outline_path], [saved.median_points], [saved.stroke_width]))
  const reread = ws.importSvg('U+4E00', record.result_svg)!.strokes[0]
  assert.deepEqual(reread.median_points, saved.median_points)
  assert.deepEqual(pathBBox(reread.outline_path), pathBBox(saved.outline_path))
})

test('같은 글자에 다시 변환하면 이력이 쌓이고 최근 것이 먼저다', () => {
  const detail = ws.importImage('U+4E00', requestOf(bar, { image: imageOf({ sha256: 'b'.repeat(64) }) }))!
  assert.equal(detail.strokes.length, 1)
  assert.deepEqual(conversionsOf('U+4E00').map((row) => row.source_sha256), ['b'.repeat(64), SHA])
})

test('길잡이 중심선(2획 이상)이 있으면 그 중심선으로 윤곽을 획별로 나누고, 바뀌기 전 획은 이력에 남아 되돌릴 수 있다', () => {
  const svg = `<svg id="z21313" viewBox="0 0 1024 1024">
    <path id="z21313d1" d="M 100 440 H 900 V 460 L 100 460 z"/><path pathLength="3333" clip-path="url(#z21313c1)" d="M 100 450 L 900 450"/>
    <path id="z21313d2" d="M 500 100 H 520 V 800 L 500 800 z"/><path pathLength="3333" clip-path="url(#z21313c2)" d="M 510 100 L 510 800"/></svg>`
  ws.importSvg('U+5341', svg)
  ws.approve('U+5341')
  const before = ws.getCharacter('U+5341')!
  assert.equal(before.strokes.length, 2)

  const detail = ws.importImage('U+5341', requestOf(cross))!
  assert.equal(detail.working, false)
  assert.equal(detail.strokes.length, 2)
  assert.equal(detail.origin, 'MANUAL')
  const [record] = conversionsOf('U+5341')
  assert.equal(record.mode, 'GUIDED')
  assert.equal(record.destination, 'STROKES')
  assert.equal(record.stroke_count, 2)

  const history = sideDb.prepare(`SELECT action_desc, undoable FROM strokes_history WHERE char = '十' ORDER BY id DESC`).all() as { action_desc: string; undoable: number }[]
  assert.equal(history[0].action_desc, '이미지 변환')
  assert.equal(history[0].undoable, 1)

  const restored = ws.undo('U+5341')!
  assert.equal(restored.strokes[0].outline_path, before.strokes[0].outline_path, '실행 취소로 이전 획이 돌아온다')
})

test('이미 획이 있어도 덩어리 방식을 고르면 덩어리를 획으로 본다', () => {
  const detail = ws.importImage('U+5341', requestOf(cross, { split: 'COMPONENTS' }))!
  assert.equal(detail.strokes.length, 1, '십자는 이어진 덩어리 하나')
  assert.equal(conversionsOf('U+5341')[0].mode, 'COMPONENTS')
})

test('실패하면 아무것도 저장하지 않고 이력도 남기지 않는다', () => {
  const before = conversionsOf('U+4E8C').length
  assert.throws(() => ws.importImage('U+4E8C', requestOf(bar, { image: imageOf({ sha256: 'oops' }) })), /SHA-256/)
  assert.throws(() => ws.importImage('U+0000', requestOf(bar)), /등록되지 않은 글자/)
  assert.equal(conversionsOf('U+4E8C').length, before)
  assert.equal(ws.getCharacter('U+4E8C')!.strokes.length, 0)
})
