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

// 옛 형식을 만들어 올리는 시험들: 새 DB를 만든 뒤 일부 테이블만 옛 모양으로 되돌린다.
function withLegacyDb(prepare: (db: DatabaseSync) => void, check: (db: DatabaseSync, dir: string) => void, options: { fresh?: boolean } = {}) {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'chusa1817.db')
    const db = new DatabaseSync(file)
    db.exec('PRAGMA foreign_keys = ON')
    if (!options.fresh) migrate(db, { backupBasePath: file })
    prepare(db)
    db.exec('PRAGMA user_version = 1')
    migrate(db, { backupBasePath: file })
    assert.equal(userVersion(db), SCHEMA_VERSION)
    check(db, dir)
    db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const insertChar = (db: DatabaseSync, unicode: string, char: string) =>
  db.prepare(`INSERT INTO characters (unicode, char, reading, last_modified_by) VALUES (?, ?, '시험', 'test')`).run(unicode, char)

test('옛 부수 이름(name_kr)을 음과 뜻으로 나눈다', () => {
  withLegacyDb((db) => {
    db.exec('DROP TABLE radicals')
    db.exec(`CREATE TABLE radicals (id INTEGER PRIMARY KEY, radical_char TEXT NOT NULL UNIQUE, variant_chars TEXT, name_kr TEXT NOT NULL, stroke_count INTEGER NOT NULL)`)
    db.exec(`INSERT INTO radicals VALUES (1, '一', '[]', '한 일', 1), (2, '丨', '[]', '뚫을 곤', 1)`)
  }, (db) => {
    assert.deepEqual(db.prepare('SELECT id, reading, meaning FROM radicals ORDER BY id').all().map((row) => ({ ...row })), [
      { id: 1, reading: '일', meaning: '한' },
      { id: 2, reading: '곤', meaning: '뚫을' },
    ])
  })
})

test('옛 편집 이력(edit_history)을 strokes_history로 옮기고 옛 표를 지운다', () => {
  withLegacyDb((db) => {
    insertChar(db, 'U+4E01', '丁')
    db.exec(`INSERT INTO strokes (char, radical, font_outline, stroke_outlines, median_line, last_modified_by, origin, origin_url)
             VALUES ('丁', 0, '[]', '[{"order":1,"path":"M 0 0 Z","radical":0}]', '[{"order":1,"points":[[0,0],[1,1]],"width":70}]', 'user', 'MMH', 'http://x')`)
    db.exec(`CREATE TABLE edit_history (id INTEGER PRIMARY KEY AUTOINCREMENT, unicode TEXT NOT NULL, snapshot_json TEXT NOT NULL, action_desc TEXT, created_at TEXT NOT NULL)`)
    const snapshot = (points: unknown) => JSON.stringify({ strokes: [{ outline_path: 'M 0 0 L 9 9 Z', median_points: points, stroke_width: 80, is_radical: 1, start_cap_type: 'NONE', end_cap_type: 'NONE' }] })
    db.prepare('INSERT INTO edit_history (unicode, snapshot_json, action_desc, created_at) VALUES (?, ?, ?, ?)').run('U+4E01', snapshot([[0, 0], [5, 5]]), '손질', '2026-01-01 00:00:00')
    // 점이 문자열(JSON)로 저장된 더 옛 형식과, 동작 이름이 없는 항목, 궁서체 교체 항목
    db.prepare('INSERT INTO edit_history (unicode, snapshot_json, action_desc, created_at) VALUES (?, ?, ?, ?)').run('U+4E01', snapshot('[[1,1],[2,2]]'), null, '2026-01-02 00:00:00')
    db.prepare('INSERT INTO edit_history (unicode, snapshot_json, action_desc, created_at) VALUES (?, ?, ?, ?)').run('U+4E01', snapshot([[3, 3], [4, 4]]), '궁서체 윤곽으로 교체', '2026-01-03 00:00:00')
  }, (db) => {
    const rows = db.prepare('SELECT action_desc, changed_by, origin, undoable, median_line FROM strokes_history ORDER BY id').all() as { action_desc: string; changed_by: string; origin: string; undoable: number; median_line: string }[]
    assert.deepEqual(rows.map((row) => [row.action_desc, row.changed_by, row.origin, row.undoable]), [
      ['손질', 'user', 'MMH', 1],
      ['편집', 'user', 'MMH', 1],
      ['궁서체 윤곽으로 교체', 'system:font', 'MMH', 1],
    ])
    assert.deepEqual(JSON.parse(rows[1].median_line)[0].points, [[1, 1], [2, 2]], '문자열 점은 배열로 풀린다')
    assert.equal(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'edit_history'`).get(), undefined)
  })
})

test('radical 열이 없던 옛 strokes는 열을 더하고 윤곽의 부수 표시를 숫자로 맞춘다', () => {
  withLegacyDb((db) => {
    insertChar(db, 'U+4E01', '丁')
    db.exec('DROP TABLE strokes_history')
    db.exec('DROP TABLE strokes')
    db.exec(`CREATE TABLE strokes (char TEXT PRIMARY KEY, font_outline JSON NOT NULL, stroke_outlines JSON NOT NULL, median_line JSON NOT NULL,
             last_modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, last_modified_by TEXT NOT NULL, origin TEXT NOT NULL, origin_url TEXT)`)
    db.exec(`INSERT INTO strokes (char, font_outline, stroke_outlines, median_line, last_modified_by, origin)
             VALUES ('丁', '[]', '[{"order":1,"path":"M 0 0 Z","radical":true},{"order":2,"path":"M 1 1 Z","radical":false}]',
                     '[{"order":1,"points":[[0,0],[1,1]],"width":70},{"order":2,"points":[[1,1],[2,2]],"width":70}]', 'user', 'MMH')`)
  }, (db) => {
    const row = db.prepare('SELECT radical, stroke_outlines FROM strokes').get() as { radical: number; stroke_outlines: string }
    assert.equal(row.radical, 0)
    assert.deepEqual(JSON.parse(row.stroke_outlines).map((item: { radical: number }) => item.radical), [1, 0])
  })
})

test("origin에 'NAVER'를 모르던 옛 strokes 표를 새 표로 바꾼다", () => {
  withLegacyDb((db) => {
    insertChar(db, 'U+4E01', '丁')
    db.exec(`INSERT INTO strokes (char, radical, font_outline, stroke_outlines, median_line, last_modified_by, origin)
             VALUES ('丁', 0, '[]', '[{"order":1,"path":"M 0 0 Z","radical":0}]', '[{"order":1,"points":[[0,0],[1,1]],"width":70}]', 'user', 'MMH')`)
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'strokes'`).get() as { sql: string }).sql
    db.exec('DROP TABLE strokes')
    db.exec(sql.replace(`'NAVER', `, ''))
    db.exec(`INSERT INTO strokes (char, radical, font_outline, stroke_outlines, median_line, last_modified_by, origin)
             VALUES ('丁', 0, '[]', '[{"order":1,"path":"M 0 0 Z","radical":0}]', '[{"order":1,"points":[[0,0],[1,1]],"width":70}]', 'user', 'MMH')`)
  }, (db) => {
    const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'strokes'`).get() as { sql: string }).sql
    assert.ok(sql.includes(`'NAVER'`))
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM strokes').get() as { n: number }).n, 1)
  })
})

test('characters의 옛 status 열과 인덱스를 지운다', () => {
  withLegacyDb((db) => {
    insertChar(db, 'U+4E01', '丁')
    db.exec(`ALTER TABLE characters ADD COLUMN status TEXT`)
    db.exec('CREATE INDEX idx_characters_status ON characters(status)')
  }, (db) => {
    const columns = (db.prepare('PRAGMA table_info(characters)').all() as { name: string }[]).map((column) => column.name)
    assert.ok(!columns.includes('status'))
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number }).n, 1)
  })
})

test('가장 옛 characters(korean_reading·issue_reason·updated_at)는 새 형식으로 바꾸고 이슈를 옮긴다', () => {
  withLegacyDb((db) => {
    db.exec(`CREATE TABLE characters (unicode TEXT PRIMARY KEY, char TEXT NOT NULL UNIQUE, grade TEXT, korean_reading TEXT, issue_reason TEXT,
             stroke_count INTEGER NOT NULL DEFAULT 0, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`)
    db.exec(`INSERT INTO characters (unicode, char, grade, korean_reading, issue_reason, stroke_count) VALUES
             ('U+4E01', '丁', '중등', '정', 'Hanja에 없음', 4), ('U+4E19', '丙', NULL, '병', NULL, 5), ('U+4E59', '乙', NULL, '을', '', 1)`)
  }, (db) => {
    const rows = db.prepare('SELECT char, reading, grade, stroke_count, last_modified_by FROM characters ORDER BY unicode').all().map((row) => ({ ...row }))
    assert.deepEqual(rows, [
      { char: '丁', reading: '정', grade: '중등', stroke_count: 4, last_modified_by: 'system:migration' },
      { char: '丙', reading: '병', grade: null, stroke_count: 5, last_modified_by: 'system:migration' },
      { char: '乙', reading: '을', grade: null, stroke_count: 1, last_modified_by: 'system:migration' },
    ])
    assert.deepEqual(db.prepare('SELECT char, reason FROM issues').all().map((row) => ({ ...row })), [{ char: '丁', reason: 'Hanja에 없음' }], '빈 사유는 옮기지 않는다')
  }, { fresh: true })
})

test('v2 DB를 v3으로 올리면 변환 이력 테이블이 생기고 기존 데이터는 그대로이며 v2 백업이 남는다', () => {
  const dir = tempDir()
  try {
    const file = path.join(dir, 'chusa1817.db')
    const db = new DatabaseSync(file)
    db.exec('PRAGMA foreign_keys = ON')
    migrate(db, { backupBasePath: file })
    db.exec(`INSERT INTO characters (unicode, char, reading, last_modified_by) VALUES ('U+4E01', '丁', '정', 'test')`)
    // v2 시절의 DB: 변환 이력 테이블이 없다.
    db.exec('DROP TABLE conversions')
    db.exec('PRAGMA user_version = 2')

    migrate(db, { backupBasePath: file })

    assert.equal(userVersion(db), SCHEMA_VERSION)
    assert.ok(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'conversions'`).get())
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number }).n, 1)
    assert.equal(backups(dir).length, 1)
    assert.match(backups(dir)[0], /^chusa1817\.before-v2-\d{8}-\d{6}\.db$/)
    db.close()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
