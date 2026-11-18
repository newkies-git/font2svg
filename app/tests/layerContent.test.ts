import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createWorkspace } from '../server/workspace.ts'
import { rectPath, strokeOf, tempDir } from './helpers.ts'

const root = tempDir()
const ws = createWorkspace(root)
const sideDb = new DatabaseSync(path.join(root, 'database', 'chusa1817.db'))
after(() => {
  ws.close()
  sideDb.close()
  fs.rmSync(root, { recursive: true, force: true })
})
ws.importInitial([{ 한자: '丁', 음: '정', 구분: '중등' }, { 한자: '丙', 음: '병', 구분: '중등' }])

const UNICODE = 'U+4E01'
const OTHER = 'U+4E19'
const stroke = strokeOf(rectPath(100, 400, 400, 460), [[110, 430], [390, 430]])
const rowOf = (unicode: string, layerId: string) => {
  const row = sideDb
    .prepare('SELECT kind, name, z_index, visible, opacity, locked, label_color, modified FROM character_layers WHERE char = (SELECT char FROM characters WHERE unicode = ?) AND layer_id = ?')
    .get(unicode, layerId) as Record<string, unknown> | undefined
  // SQLite가 돌려주는 행은 prototype이 없으므로 일반 객체로 펼쳐 비교한다.
  return row && { ...row }
}

test('저장된 행이 없는 기본 레이어에 내용을 저장하면 기본 표시 설정으로 행을 만든다', () => {
  assert.equal(rowOf(UNICODE, 'outline'), undefined)
  ws.saveLayer(UNICODE, 'outline', { strokes: [stroke] })
  assert.deepEqual(rowOf(UNICODE, 'outline'), {
    kind: 'OUTLINE', name: '획 윤곽 (매핑)', z_index: 1, visible: 0, opacity: 0.7, locked: 0, label_color: 'rose', modified: 1,
  })
})

test('이미 있는 행의 표시 설정은 내용을 저장해도 바뀌지 않는다', () => {
  ws.updateLayersMeta(OTHER, [{ id: 'outline', name: '내 윤곽', opacity: 0.4, label_color: 'blue', visible: true, z_index: 9 }])
  ws.saveLayer(OTHER, 'outline', { strokes: [stroke] })
  assert.deepEqual(rowOf(OTHER, 'outline'), {
    kind: 'OUTLINE', name: '내 윤곽', z_index: 9, visible: 1, opacity: 0.4, locked: 0, label_color: 'blue', modified: 1,
  })
})

test('기본으로 잠긴 레이어는 행이 없으면 저장되지 않고, 오버레이·없는 레이어는 거부한다', () => {
  assert.throws(() => ws.saveLayer(UNICODE, 'mmh', { strokes: [stroke] }), /편집하지/)
  assert.equal(rowOf(UNICODE, 'mmh'), undefined)
  assert.throws(() => ws.saveLayer(UNICODE, 'medians', { strokes: [stroke] }), /오버레이 레이어/)
  assert.throws(() => ws.saveLayer(UNICODE, 'nope', { strokes: [stroke] }), /존재하지 않는 레이어/)
})

test('잠금을 푼 기본 레이어는 저장하면 그 행의 설정을 유지한 채 내용만 채운다', () => {
  ws.updateLayersMeta(UNICODE, [{ id: 'font', locked: false, opacity: 0.2 }])
  ws.saveLayer(UNICODE, 'font', { paths: [rectPath(100, 400, 400, 460)] })
  assert.deepEqual(rowOf(UNICODE, 'font'), {
    kind: 'FONT', name: '궁서체 (TTF)', z_index: 0, visible: 1, opacity: 0.2, locked: 0, label_color: 'slate', modified: 1,
  })
})
