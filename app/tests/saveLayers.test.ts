import assert from 'node:assert/strict'
import fs from 'node:fs'
import test, { after } from 'node:test'
import { createWorkspace } from '../server/workspace.ts'
import type { StrokeRecord } from '../shared/types.ts'
import { rectPath, strokeOf, tempDir } from './helpers.ts'

// 작업 공간은 프로세스당 하나(싱글턴)라 이 파일의 테스트가 같은 임시 DB를 공유한다. 각 테스트는 자기 글자를 쓴다.
const root = tempDir()
const ws = createWorkspace(root)
after(() => {
  ws.close()
  fs.rmSync(root, { recursive: true, force: true })
})

ws.importInitial([
  { 한자: '丁', 음: '정', 구분: '중등' },
  { 한자: '丙', 음: '병', 구분: '중등' },
  { 한자: '乙', 음: '을', 구분: '중등' },
  { 한자: '甲', 음: '갑', 구분: '중등' },
  { 한자: '戊', 음: '무', 구분: '중등' },
])

const bar = (y: number): StrokeRecord => strokeOf(rectPath(100, y, 400, y + 60), [[110, y + 30], [390, y + 30]])
const detailOf = (unicode: string) => ws.getCharacter(unicode)!
const layerOf = (unicode: string, id: string) => detailOf(unicode).layers.find((layer) => layer.id === id)!

const unlock = (unicode: string, id: string) => ws.updateLayersMeta(unicode, [{ id, locked: false }])

function seedStrokes(unicode: string, count: number) {
  ws.updateStrokes(unicode, Array.from({ length: count }, (_, i) => bar(100 + i * 100)) as never, '초기')
}

test('여러 레이어를 한 번에 저장한다', () => {
  const unicode = 'U+4E01'
  seedStrokes(unicode, 1)
  unlock(unicode, 'mmh')
  const result = ws.saveLayers(unicode, [
    { id: 'strokes', strokes: [bar(100), bar(300)], action: '작업 획 편집' },
    { id: 'mmh', strokes: [bar(500)] },
  ])!
  assert.equal(result.strokes.length, 2)
  assert.equal(layerOf(unicode, 'strokes').strokes.length, 2)
  assert.equal(layerOf(unicode, 'mmh').strokes.length, 1)
  assert.equal(layerOf(unicode, 'mmh').modified, true)
})

test('하나라도 실패하면 모두 되돌린다(부분 저장 없음)', () => {
  const unicode = 'U+4E19'
  seedStrokes(unicode, 1)
  unlock(unicode, 'mmh')
  const historyBefore = detailOf(unicode).history_count
  assert.throws(() => ws.saveLayers(unicode, [
    { id: 'strokes', strokes: [bar(100), bar(300), bar(500)] },
    { id: 'mmh', strokes: [{ ...bar(100), outline_path: 'M 0 0 <bad>' }] },
  ]), /SVG 외곽선 경로/)
  assert.equal(detailOf(unicode).strokes.length, 1, '앞의 작업 획 변경도 되돌아가야 한다')
  assert.equal(detailOf(unicode).history_count, historyBefore, '이력도 남지 않아야 한다')
  assert.equal(layerOf(unicode, 'mmh').modified, false)
})

test('존재하지 않는 레이어가 섞이면 전부 되돌린다', () => {
  const unicode = 'U+4E59'
  seedStrokes(unicode, 1)
  assert.throws(() => ws.saveLayers(unicode, [
    { id: 'strokes', strokes: [bar(100), bar(300)] },
    { id: 'nope', strokes: [bar(100)] },
  ]), /존재하지 않는 레이어/)
  assert.equal(detailOf(unicode).strokes.length, 1)
})

test('입력 검증: 빈 목록, 중복 id, id 없음, 개수 초과, 없는 글자', () => {
  const unicode = 'U+7532'
  assert.throws(() => ws.saveLayers(unicode, []), /비어 있습니다/)
  assert.throws(() => ws.saveLayers(unicode, 'x'), /비어 있습니다/)
  assert.throws(() => ws.saveLayers(unicode, [{ id: 'mmh' }, { id: 'mmh' }]), /중복/)
  assert.throws(() => ws.saveLayers(unicode, [{ strokes: [] }]), /id가 없습니다/)
  assert.throws(() => ws.saveLayers(unicode, Array.from({ length: 65 }, (_, i) => ({ id: `custom-${i}` }))), /까지입니다/)
  assert.throws(() => ws.saveLayers('U+FFFF', [{ id: 'mmh', strokes: [] }]))
})

test('한 개짜리 저장(saveLayer)도 그대로 동작한다', () => {
  const unicode = 'U+620A'
  seedStrokes(unicode, 1)
  unlock(unicode, 'mmh')
  ws.saveLayer(unicode, 'strokes', { strokes: [bar(100), bar(300)], action: '단일' })
  assert.equal(detailOf(unicode).strokes.length, 2)
  ws.saveLayer(unicode, 'mmh', { strokes: [bar(100)] })
  assert.equal(layerOf(unicode, 'mmh').strokes.length, 1)
})

test('잠긴 레이어는 저장을 거부하고, 일괄 저장이면 전부 되돌린다', () => {
  const unicode = 'U+620A'
  seedStrokes(unicode, 1)
  // 레퍼런스 레이어는 기본이 잠금이다.
  assert.throws(() => ws.saveLayer(unicode, 'naver', { strokes: [bar(100)] }), /잠긴 레이어/)
  assert.throws(() => ws.saveLayers(unicode, [
    { id: 'strokes', strokes: [bar(100), bar(300), bar(500)] },
    { id: 'naver', strokes: [bar(100)] },
  ]), /잠긴 레이어/)
  assert.equal(detailOf(unicode).strokes.length, 1, '앞의 작업 획 변경도 되돌아가야 한다')
  unlock(unicode, 'naver')
  ws.saveLayer(unicode, 'naver', { strokes: [bar(100)] })
  assert.equal(layerOf(unicode, 'naver').strokes.length, 1)
})

test('작업 획 레이어를 잠그면 저장을 거부한다', () => {
  const unicode = 'U+620A'
  ws.updateLayersMeta(unicode, [{ id: 'strokes', locked: true }])
  assert.throws(() => ws.saveLayer(unicode, 'strokes', { strokes: [bar(100)] }), /잠긴 레이어/)
  ws.updateLayersMeta(unicode, [{ id: 'strokes', locked: false }])
  ws.saveLayer(unicode, 'strokes', { strokes: [bar(100)] })
})
