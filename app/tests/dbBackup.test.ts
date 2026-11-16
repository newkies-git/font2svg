import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { backupDatabase, backupPathFor, timestampOf } from '../server/dbBackup.ts'
import { openMigratedDb, tempDir } from './helpers.ts'

test('백업 파일 이름: 같은 폴더, 라벨과 시각', () => {
  const date = new Date(2026, 10, 16, 11, 4, 32)
  assert.equal(timestampOf(date), '20261116-110432')
  assert.equal(backupPathFor('/x/db/chusa1817.db', 'backup', date), path.join('/x/db', 'chusa1817.backup-20261116-110432.db'))
})

test('백업은 일관된 복사본을 만들고 덮어쓰지 않는다', () => {
  const dir = tempDir()
  try {
    const { db } = openMigratedDb(dir)
    db.exec(`INSERT INTO characters (unicode, char, reading, last_modified_by) VALUES ('U+4E01', '丁', '정', 'test')`)
    const destination = path.join(dir, 'copy.db')
    const result = backupDatabase(db, destination)
    assert.equal(result.path, destination)
    assert.ok(result.bytes > 0)
    const copy = new DatabaseSync(destination, { readOnly: true })
    assert.equal((copy.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number }).n, 1)
    copy.close()
    assert.throws(() => backupDatabase(db, destination), /이미 있습니다/)
    db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
