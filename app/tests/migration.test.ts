import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, migrate, SCHEMA_VERSION } from '../server/schema.ts'
import { tempDir } from './helpers.ts'

const userVersion = (db: DatabaseSync) => (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
const layerSql = (db: DatabaseSync) => (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'character_layers'`).get() as { sql: string }).sql
const backups = (dir: string) => fs.readdirSync(dir).filter((name) => name.includes('.before-'))

test('마이그레이션 버전은 오름차순이고 SCHEMA_VERSION이 마지막이다', () => {
  const versions = MIGRATIONS.map((m) => m.version)
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b))
  assert.equal(new Set(versions).size, versions.length)
  assert.equal(SCHEMA_VERSION, versions[versions.length - 1])
})

test('새 DB는 백업 없이 최신 버전이 된다', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'chusa1817.db')
    const db = new DatabaseSync(file)
    migrate(db, { backupBasePath: file })
    assert.equal(userVersion(db), SCHEMA_VERSION)
    assert.ok(layerSql(db).includes(`'OUTLINE'`))
    assert.deepEqual(backups(dir), [])
    db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('옛 형식 DB는 먼저 백업하고, 데이터를 보존한 채 올린다', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'chusa1817.db')
    const db = new DatabaseSync(file)
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db, { backupBasePath: file })
    db.exec(`INSERT INTO characters (unicode, char, reading, last_modified_by) VALUES ('U+4E01', '丁', '정', 'test')`)
    // OUTLINE을 모르던 시절의 character_layers로 되돌린다.
    const legacySql = layerSql(db).replace(`'OUTLINE', `, '')
    db.exec('DROP TABLE character_layers')
    db.exec(legacySql)
    db.exec(`INSERT INTO character_layers (char, layer_id, kind, name, z_index) VALUES ('丁', 'mmh', 'MMH', 'Hanzi', 1)`)
    db.exec('PRAGMA user_version = 1')
    assert.ok(!layerSql(db).includes(`'OUTLINE'`))

    migrate(db, { backupBasePath: file })

    assert.equal(userVersion(db), SCHEMA_VERSION)
    assert.ok(layerSql(db).includes(`'OUTLINE'`))
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM character_layers').get() as { n: number }).n, 1)
    assert.equal(backups(dir).length, 1)
    assert.match(backups(dir)[0], /^chusa1817\.before-v1-\d{8}-\d{6}\.db$/)

    migrate(db, { backupBasePath: file })
    assert.equal(backups(dir).length, 1, '이미 최신이면 다시 백업하지 않는다')
    db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('앱보다 높은 스키마 버전은 거부한다', () => {
  const dir = tempDir()
  try {
    const db = new DatabaseSync(path.join(dir, 'chusa1817.db'))
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    assert.throws(() => migrate(db), /보다 높습니다/)
    db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
