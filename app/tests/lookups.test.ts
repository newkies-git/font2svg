import assert from 'node:assert/strict'
import fs from 'node:fs'
import test, { after } from 'node:test'
import { charactersAfter, readReferenceRow } from '../server/lookups.ts'
import { insertCharacter, openMigratedDb, tempDir } from './helpers.ts'

const dir = tempDir()
const { db } = openMigratedDb(dir)
after(() => {
  db.close()
  fs.rmSync(dir, { recursive: true, force: true })
})
for (const [unicode, char] of [['U+4E01', '丁'], ['U+4E09', '三'], ['U+4E19', '丙'], ['U+4E59', '乙']]) insertCharacter(db, unicode, char)

test('유니코드 순서로 after 다음부터 limit자를 돌려준다', () => {
  assert.deepEqual(charactersAfter(db, '', 2).map((row) => row.char), ['丁', '三'])
  assert.deepEqual(charactersAfter(db, 'U+4E09', 5).map((row) => row.char), ['丙', '乙'])
  assert.deepEqual(charactersAfter(db, 'U+4E59', 5), [])
  assert.deepEqual({ ...charactersAfter(db, '', 1)[0] }, { unicode: 'U+4E01', char: '丁' })
})

test('레퍼런스 기록: 있으면 행을, 없으면 undefined(없음 캐시는 found 0)', () => {
  assert.equal(readReferenceRow(db, 'U+4E01', 'NAVER'), undefined)
  db.prepare(`INSERT INTO reference_data (unicode, source, source_version, source_url, raw_data, raw_sha256, found) VALUES ('U+4E01', 'NAVER', 'v', 'http://x', NULL, NULL, 0)`).run()
  assert.deepEqual({ ...readReferenceRow(db, 'U+4E01', 'NAVER')! }, { found: 0, raw_data: null, source_url: 'http://x' })
  assert.equal(readReferenceRow(db, 'U+4E01', 'MMH'), undefined, '출처별로 따로 기록한다')
})
