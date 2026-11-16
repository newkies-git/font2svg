import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { createWorkspace } from '../server/workspace.ts'
import { rectPath, strokeOf, tempDir } from './helpers.ts'

const root = tempDir()
const ws = createWorkspace(root)
// 작업 데이터는 외부 수신으로만 생기므로, 승인 테스트는 같은 DB 파일에 직접 넣는다.
const sideDb = new DatabaseSync(path.join(root, 'database', 'chusa1817.db'))
after(() => {
  ws.close()
  sideDb.close()
  fs.rmSync(root, { recursive: true, force: true })
})

ws.importInitial([
  { 한자: '丁', 음: '정', 구분: '중등' },
  { 한자: '丙', 음: '병', 구분: '중등' },
  { 한자: '乙', 음: '을', 구분: '중등' },
])

const bar = (y: number) => strokeOf(rectPath(100, y, 400, y + 60), [[110, y + 30], [390, y + 30]])
const detailOf = (unicode: string) => ws.getCharacter(unicode)!

// 작업 데이터를 만든 뒤 승인해 strokes 행이 있는 상태로 만든다(strokes 행이 있어야 편집 이력이 쌓인다).
function seedApproved(unicode: string, char: string, strokeWidth = 70) {
  const outlines = [{ order: 1, path: bar(100).outline_path, radical: false }]
  const medians = [{ order: 1, points: bar(100).median_points, width: strokeWidth }]
  sideDb.prepare(`INSERT INTO working_data (char, source, font_outline, stroke_outlines, median_line, last_modified_by) VALUES (?, 'MANUAL', '[]', ?, ?, 'test')`)
    .run(char, JSON.stringify(outlines), JSON.stringify(medians))
  ws.approve(unicode)
}

test('작업 데이터를 승인하면 strokes로 옮기고 작업 데이터를 지운다', () => {
  const unicode = 'U+4E01'
  sideDb.prepare(`INSERT INTO working_data (char, source, font_outline, stroke_outlines, median_line, last_modified_by) VALUES ('丁', 'MANUAL', '[]', ?, ?, 'test')`)
    .run(JSON.stringify([{ order: 1, path: bar(100).outline_path, radical: false }]), JSON.stringify([{ order: 1, points: bar(100).median_points, width: 70 }]))
  assert.equal(detailOf(unicode).working, true)
  ws.approve(unicode)
  const after = detailOf(unicode)
  assert.equal(after.working, false)
  assert.equal(after.strokes.length, 1)
  assert.equal(after.strokes[0].stroke_width, 70)
  assert.equal(sideDb.prepare(`SELECT COUNT(*) AS n FROM working_data WHERE char = '丁'`).get()!.n, 0)
  assert.throws(() => ws.approve(unicode), /승인할 작업 데이터가 없습니다/)
})

test('작업 데이터가 없으면 승인할 수 없다', () => {
  assert.throws(() => ws.approve('U+4E19'), /승인할 작업 데이터가 없습니다/)
})

test('되돌리기: 이전 상태로 가고, 되돌린 이력은 다시 되돌릴 대상이 아니다', () => {
  const unicode = 'U+4E59'
  seedApproved(unicode, '乙')
  ws.updateStrokes(unicode, [bar(100), bar(300)] as never, '추가')
  assert.equal(detailOf(unicode).strokes.length, 2)
  ws.undo(unicode)
  assert.equal(detailOf(unicode).strokes.length, 1)
  assert.equal(detailOf(unicode).strokes[0].stroke_width, 70)
  assert.throws(() => ws.undo(unicode), /되돌릴 편집이 없습니다/)
  const rows = sideDb.prepare(`SELECT action_desc, undoable FROM strokes_history WHERE char = '乙' ORDER BY id`).all()
  assert.deepEqual(rows.map((row) => row.action_desc), ['추가', '실행 취소'], '이력은 지우지 않고 남는다')
  assert.deepEqual(rows.map((row) => row.undoable), [0, 0])
})

test('되돌릴 편집이 없으면 거부한다', () => {
  assert.throws(() => ws.undo('U+4E19'), /되돌릴 편집이 없습니다/)
})
