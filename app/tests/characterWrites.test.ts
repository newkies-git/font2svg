import assert from 'node:assert/strict'
import fs from 'node:fs'
import test, { after } from 'node:test'
import { markCharacterEdited, setCharacterStrokeCount } from '../server/characterWrites.ts'
import { insertCharacter, openMigratedDb, tempDir } from './helpers.ts'

const dir = tempDir()
const { db } = openMigratedDb(dir)
after(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
insertCharacter(db, 'U+4E01', '丁')
insertCharacter(db, 'U+4E09', '三')

const rowOf = (unicode: string) => ({ ...(db.prepare('SELECT stroke_count, last_modified_by FROM characters WHERE unicode = ?').get(unicode) as object) })

test('마지막 수정자만 바꾸고 획 수와 다른 글자는 건드리지 않는다', () => {
  setCharacterStrokeCount(db, 'U+4E01', 2, 'seed')
  const before = rowOf('U+4E09')
  markCharacterEdited(db, 'U+4E01', 'user')
  assert.deepEqual(rowOf('U+4E01'), { stroke_count: 2, last_modified_by: 'user' })
  assert.deepEqual(rowOf('U+4E09'), before)
})

test('획 수와 마지막 수정자를 함께 바꾼다', () => {
  setCharacterStrokeCount(db, 'U+4E09', 3, 'font')
  assert.deepEqual(rowOf('U+4E09'), { stroke_count: 3, last_modified_by: 'font' })
})

test('없는 글자는 조용히 아무것도 바꾸지 않는다', () => {
  assert.doesNotThrow(() => markCharacterEdited(db, 'U+0000', 'user'))
  assert.doesNotThrow(() => setCharacterStrokeCount(db, 'U+0000', 9, 'user'))
})
