import type { DatabaseSync } from 'node:sqlite'
import { CANVAS, DEFAULT_STROKE_WIDTH, KANGXI_COUNT, SHA256_HEX_LENGTH } from '../src/lib/constants.ts'
import { ACTION_FONT, ACTOR_FONT, ACTOR_MIGRATION, ACTOR_USER } from './model.ts'
import type { Pt } from '../src/types.ts'
import { KANGXI_RADICALS } from './radicals.ts'

export const NO_FONT_SHA256 = '0'.repeat(SHA256_HEX_LENGTH)

const STROKES_DDL = `
  CREATE TABLE IF NOT EXISTS strokes (
    char TEXT PRIMARY KEY REFERENCES characters(char) ON DELETE CASCADE,
    radical INTEGER NOT NULL DEFAULT 0 CHECK (radical BETWEEN 0 AND ${KANGXI_COUNT}),
    font_outline JSON NOT NULL CHECK (json_valid(font_outline) AND json_type(font_outline) = 'array'),
    stroke_outlines JSON NOT NULL
      CHECK (json_valid(stroke_outlines) AND json_type(stroke_outlines) = 'array' AND json_array_length(stroke_outlines) >= 1),
    median_line JSON NOT NULL
      CHECK (json_valid(median_line) AND json_type(median_line) = 'array' AND json_array_length(median_line) = json_array_length(stroke_outlines)),
    last_modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_modified_by TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('MMH', 'ACJK', 'NAVER', 'IDS', 'OLLAMA_IDS', 'MANUAL', 'NONE')),
    origin_url TEXT
  )
`

// strokes가 바뀔 때마다, 바뀌기 전 행을 그대로 남긴다(삭제하지 않는다). 현재 상태는 strokes에 있다.
const STROKES_HISTORY_DDL = `
  CREATE TABLE IF NOT EXISTS strokes_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    char TEXT NOT NULL REFERENCES characters(char) ON DELETE CASCADE,
    radical INTEGER NOT NULL,
    font_outline JSON NOT NULL CHECK (json_valid(font_outline) AND json_type(font_outline) = 'array'),
    stroke_outlines JSON NOT NULL CHECK (json_valid(stroke_outlines) AND json_type(stroke_outlines) = 'array'),
    median_line JSON NOT NULL CHECK (json_valid(median_line) AND json_type(median_line) = 'array'),
    origin TEXT NOT NULL,
    origin_url TEXT,
    state_modified_at DATETIME NOT NULL,
    state_modified_by TEXT NOT NULL,
    action_desc TEXT NOT NULL,
    changed_by TEXT NOT NULL,
    changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    undoable INTEGER NOT NULL DEFAULT 1 CHECK (undoable IN (0, 1))
  );
  CREATE INDEX IF NOT EXISTS idx_strokes_history_char ON strokes_history(char, id DESC)
`

export type StrokeRow = {
  char: string
  radical: number
  font_outline: string
  stroke_outlines: string
  median_line: string
  last_modified_at: string
  last_modified_by: string
  origin: string
  origin_url: string | null
}

export type CharacterRow = {
  unicode: string
  char: string
  grade: string | null
  reading: string | null
  meaning: string | null
  variant_reading: string
  variant_meaning: string
  stroke_count: number
  last_modified_at: string
  last_modified_by: string
}

function charactersDdl(name: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${name} (
      unicode TEXT PRIMARY KEY,
      char TEXT NOT NULL UNIQUE,
      grade TEXT,
      reading TEXT,
      meaning TEXT,
      variant_reading JSON NOT NULL DEFAULT '[]' CHECK (json_valid(variant_reading) AND json_type(variant_reading) = 'array'),
      variant_meaning JSON NOT NULL DEFAULT '[]' CHECK (json_valid(variant_meaning) AND json_type(variant_meaning) = 'array'),
      stroke_count INTEGER NOT NULL DEFAULT 0,
      last_modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_modified_by TEXT NOT NULL
    )
  `
}

// status: OPEN(작업 전) / DRAFT(작업 데이터가 있어 승인 대기) / APPROVED(승인해 strokes로 옮김). in_font: 궁서체에 글리프가 있는지.
const ISSUE_STATUS_COLUMN = `status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DRAFT', 'APPROVED'))`
const ISSUE_IN_FONT_COLUMN = 'in_font INTEGER NOT NULL DEFAULT 0 CHECK (in_font IN (0, 1))'
const ISSUES_DDL = `
  CREATE TABLE IF NOT EXISTS issues (
    char TEXT PRIMARY KEY REFERENCES characters(char) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ${ISSUE_STATUS_COLUMN},
    ${ISSUE_IN_FONT_COLUMN}
  )
`

// Hanja에 없는 글자의 IDS 합성 초안·궁서체 추출 데이터·수작업 데이터. 승인하면 strokes로 옮기고 지운다.
// FONT는 궁서체 윤곽만 있고 획이 없는 경우다.
const WORKING_DATA_DDL = `
  CREATE TABLE IF NOT EXISTS working_data (
    char TEXT PRIMARY KEY REFERENCES characters(char) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('IDS', 'OLLAMA_IDS', 'MANUAL', 'FONT')),
    source_url TEXT,
    font_outline JSON NOT NULL CHECK (json_valid(font_outline) AND json_type(font_outline) = 'array'),
    stroke_outlines JSON NOT NULL CHECK (json_valid(stroke_outlines) AND json_type(stroke_outlines) = 'array'),
    median_line JSON NOT NULL
      CHECK (json_valid(median_line) AND json_type(median_line) = 'array' AND json_array_length(median_line) = json_array_length(stroke_outlines)),
    last_modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_modified_by TEXT NOT NULL
  )
`

function upgradeCharactersTable(db: DatabaseSync) {
  const columns = (db.prepare('PRAGMA table_info(characters)').all() as { name: string }[]).map((column) => column.name)
  if (columns.length === 0) return
  if (columns.includes('korean_reading')) db.exec('ALTER TABLE characters RENAME COLUMN korean_reading TO reading')
  addColumn(db, 'characters', 'meaning', 'TEXT')
  addColumn(db, 'characters', 'variant_reading', `JSON NOT NULL DEFAULT '[]' CHECK (json_valid(variant_reading) AND json_type(variant_reading) = 'array')`)
  addColumn(db, 'characters', 'variant_meaning', `JSON NOT NULL DEFAULT '[]' CHECK (json_valid(variant_meaning) AND json_type(variant_meaning) = 'array')`)
  if (columns.includes('last_modified_by')) return
  // 자식 테이블이 characters를 참조하므로, 외래키를 끄고 새 테이블로 갈아끼운다(자식 행이 연쇄 삭제되지 않게).
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('BEGIN')
  try {
    db.exec(ISSUES_DDL)
    if (columns.includes('issue_reason')) {
      db.exec(`
        INSERT OR IGNORE INTO issues (char, reason)
        SELECT char, issue_reason FROM characters WHERE issue_reason IS NOT NULL AND issue_reason <> ''
      `)
    }
    db.exec(charactersDdl('characters_next'))
    db.exec(`
      INSERT INTO characters_next (unicode, char, grade, reading, meaning, variant_reading, variant_meaning,
                                   stroke_count, last_modified_at, last_modified_by)
      SELECT unicode, char, grade, reading, meaning, variant_reading, variant_meaning,
             stroke_count, updated_at, '${ACTOR_MIGRATION}'
      FROM characters
    `)
    db.exec('DROP TABLE characters')
    db.exec('ALTER TABLE characters_next RENAME TO characters')
    const broken = db.prepare('PRAGMA foreign_key_check').all()
    if (broken.length > 0) throw new Error('characters 테이블 변환 후 외래키가 깨졌습니다.')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

function upgradeStrokesTable(db: DatabaseSync) {
  const columns = db.prepare('PRAGMA table_info(strokes)').all() as { name: string }[]
  if (columns.length === 0 || columns.some((column) => column.name === 'radical')) return
  db.exec('BEGIN')
  try {
    db.exec('ALTER TABLE strokes RENAME TO strokes_previous')
    db.exec(STROKES_DDL)
    db.exec(`
      INSERT INTO strokes (char, radical, font_outline, stroke_outlines, median_line, last_modified_at, last_modified_by, origin, origin_url)
      SELECT p.char, 0, p.font_outline,
        (SELECT json_group_array(json_object(
          'order', json_extract(e.value, '$.order'),
          'path', json_extract(e.value, '$.path'),
          'radical', CASE WHEN json_extract(e.value, '$.radical') THEN 1 ELSE 0 END
        )) FROM json_each(p.stroke_outlines) e),
        p.median_line, p.last_modified_at, p.last_modified_by, p.origin, p.origin_url
      FROM strokes_previous p
    `)
    db.exec('DROP TABLE strokes_previous')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// origin CHECK에 'NAVER'가 없는 옛 테이블이면 새 테이블로 갈아끼운다.
function upgradeStrokeOrigins(db: DatabaseSync) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'strokes'`).get() as { sql: string } | undefined
  if (!row || row.sql.includes(`'NAVER'`)) return
  db.exec('BEGIN')
  try {
    db.exec('ALTER TABLE strokes RENAME TO strokes_previous')
    db.exec(STROKES_DDL)
    db.exec('INSERT INTO strokes SELECT * FROM strokes_previous')
    db.exec('DROP TABLE strokes_previous')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function dropStatusColumn(db: DatabaseSync) {
  const columns = db.prepare('PRAGMA table_info(characters)').all() as { name: string }[]
  if (!columns.some((column) => column.name === 'status')) return
  db.exec('DROP INDEX IF EXISTS idx_characters_status')
  db.exec('ALTER TABLE characters DROP COLUMN status')
}

export function migrate(db: DatabaseSync) {
  upgradeCharactersTable(db)
  dropStatusColumn(db)
  upgradeStrokesTable(db)
  upgradeStrokeOrigins(db)
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      project_name TEXT NOT NULL,
      ttf_filename TEXT NOT NULL,
      ttf_sha256 TEXT NOT NULL,
      ttf_units_per_em INTEGER NOT NULL,
      canvas_size INTEGER NOT NULL DEFAULT ${CANVAS},
      default_stroke_width INTEGER NOT NULL DEFAULT ${DEFAULT_STROKE_WIDTH},
      stroke_order_standard TEXT NOT NULL DEFAULT 'KR',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS radicals (
      id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND ${KANGXI_COUNT}),
      radical_char TEXT NOT NULL UNIQUE,
      variant_chars TEXT,
      reading TEXT NOT NULL,
      meaning TEXT NOT NULL,
      stroke_count INTEGER NOT NULL
    );
    ${charactersDdl('characters')};
    ${ISSUES_DDL};
    ${STROKES_DDL};
    ${STROKES_HISTORY_DDL};
    CREATE TABLE IF NOT EXISTS reference_data (
      unicode TEXT NOT NULL,
      source TEXT NOT NULL,
      source_version TEXT NOT NULL,
      source_url TEXT,
      raw_data TEXT,
      raw_sha256 TEXT,
      found INTEGER NOT NULL,
      fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (unicode, source),
      FOREIGN KEY (unicode) REFERENCES characters(unicode) ON DELETE CASCADE
    );
    CREATE TRIGGER IF NOT EXISTS trg_characters_updated AFTER UPDATE ON characters
    WHEN NEW.last_modified_at = OLD.last_modified_at
    BEGIN
      UPDATE characters SET last_modified_at = CURRENT_TIMESTAMP WHERE unicode = NEW.unicode;
    END;
  `)
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (!version.user_version) db.exec('PRAGMA user_version = 1')
  addColumn(db, 'reference_data', 'source_url', 'TEXT')
  splitRadicalNames(db)
  migrateEditHistory(db)
  introduceWorkingData(db)
}

// 작업 데이터(working_data)를 도입하면서, strokes에 있던 IDS·Ollama·수작업 초안을 승인 대기 작업 데이터로 되돌린다.
// 처음 한 번만 한다(이후 승인한 글자는 같은 origin으로 strokes에 있어야 한다). 되돌리기 전 strokes 행은 이력에 남긴다.
// 궁서체 글리프 유무(in_font)는 폰트를 읽어야 알 수 있어 여기서는 0으로 둔다.
function introduceWorkingData(db: DatabaseSync) {
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'working_data'`).get()) return
  addColumn(db, 'issues', 'status', ISSUE_STATUS_COLUMN)
  addColumn(db, 'issues', 'in_font', ISSUE_IN_FONT_COLUMN)
  const drafts = `FROM strokes WHERE origin IN ('IDS', 'OLLAMA_IDS', 'MANUAL')`
  db.exec('BEGIN')
  try {
    db.exec(WORKING_DATA_DDL)
    db.exec(`
      INSERT INTO strokes_history (char, radical, font_outline, stroke_outlines, median_line, origin, origin_url,
                                   state_modified_at, state_modified_by, action_desc, changed_by, undoable)
      SELECT char, radical, font_outline, stroke_outlines, median_line, origin, origin_url,
             last_modified_at, last_modified_by, '작업 데이터로 이동', '${ACTOR_MIGRATION}', 0 ${drafts}
    `)
    db.exec(`
      INSERT INTO working_data (char, source, source_url, font_outline, stroke_outlines, median_line, last_modified_at, last_modified_by)
      SELECT char, origin, origin_url, font_outline, stroke_outlines, median_line, last_modified_at, last_modified_by ${drafts}
    `)
    db.exec(`
      INSERT INTO issues (char, reason, status)
      SELECT char, 'Hanja에 없음: ' || origin || ' 합성 초안', 'DRAFT' ${drafts}
      ON CONFLICT(char) DO UPDATE SET reason = excluded.reason, status = excluded.status
    `)
    db.exec(`UPDATE characters SET stroke_count = 0, last_modified_by = '${ACTOR_MIGRATION}' WHERE char IN (SELECT char ${drafts})`)
    db.exec(`DELETE ${drafts}`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// 옛 edit_history(글자별 획 배열 스냅샷)를 strokes_history로 옮기고 지운다. 스냅샷에 없는 값은 지금 행에서 가져온다:
// font_outline은 그때 획 윤곽과 같았고, origin·origin_url은 윤곽 교체로 바뀌지 않았다. 그 상태가 만들어진 시각은 알 수 없어 변경 시각으로 채운다.
function migrateEditHistory(db: DatabaseSync) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'edit_history'`).get()) return
  type OldItem = { outline_path: string; median_points: Pt[] | string; stroke_width: number; is_radical: number; start_cap_type: string; end_cap_type: string }
  const rows = db.prepare(`
    SELECT c.char, e.snapshot_json, e.action_desc, e.created_at, s.origin, s.origin_url
    FROM edit_history e JOIN characters c ON c.unicode = e.unicode JOIN strokes s ON s.char = c.char
    ORDER BY e.id
  `).all() as { char: string; snapshot_json: string; action_desc: string | null; created_at: string; origin: string; origin_url: string | null }[]
  const insert = db.prepare(`
    INSERT INTO strokes_history (char, radical, font_outline, stroke_outlines, median_line, origin, origin_url,
                                 state_modified_at, state_modified_by, action_desc, changed_by, changed_at, undoable)
    VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `)
  db.exec('BEGIN')
  try {
    for (const row of rows) {
      const items = (JSON.parse(row.snapshot_json) as { strokes: OldItem[] }).strokes
      const outlines = items.map((item, index) => ({ order: index + 1, path: item.outline_path, radical: item.is_radical ? 1 : 0 }))
      const lines = items.map((item, index) => ({
        order: index + 1,
        points: typeof item.median_points === 'string' ? JSON.parse(item.median_points) as Pt[] : item.median_points,
        width: item.stroke_width,
        start_cap: item.start_cap_type,
        end_cap: item.end_cap_type,
      }))
      const action = row.action_desc ?? '편집'
      insert.run(row.char, JSON.stringify(items.map((item) => item.outline_path)), JSON.stringify(outlines), JSON.stringify(lines),
        row.origin, row.origin_url, row.created_at, ACTOR_MIGRATION, action, action === ACTION_FONT ? ACTOR_FONT : ACTOR_USER, row.created_at)
    }
    db.exec('DROP TABLE edit_history')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

// 옛 name_kr('훈 음', 공백 하나)을 reading(음)과 meaning(훈)으로 나눠 새 테이블로 갈아끼운다.
function splitRadicalNames(db: DatabaseSync) {
  const columns = db.prepare('PRAGMA table_info(radicals)').all() as { name: string }[]
  if (!columns.some((column) => column.name === 'name_kr')) return
  db.exec('BEGIN')
  try {
    db.exec('ALTER TABLE radicals RENAME TO radicals_previous')
    db.exec(`
      CREATE TABLE radicals (
        id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND ${KANGXI_COUNT}),
        radical_char TEXT NOT NULL UNIQUE,
        variant_chars TEXT,
        reading TEXT NOT NULL,
        meaning TEXT NOT NULL,
        stroke_count INTEGER NOT NULL
      )
    `)
    db.exec(`
      INSERT INTO radicals (id, radical_char, variant_chars, reading, meaning, stroke_count)
      SELECT id, radical_char, variant_chars,
             substr(name_kr, instr(name_kr, ' ') + 1), substr(name_kr, 1, instr(name_kr, ' ') - 1), stroke_count
      FROM radicals_previous
    `)
    db.exec('DROP TABLE radicals_previous')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function addColumn(db: DatabaseSync, table: string, name: string, type: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
}

export function seed(db: DatabaseSync) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM radicals').get() as { n: number }
  if (count.n === 0) {
    const insert = db.prepare('INSERT INTO radicals (id, radical_char, variant_chars, reading, meaning, stroke_count) VALUES (?, ?, ?, ?, ?, ?)')
    for (const radical of KANGXI_RADICALS) {
      insert.run(radical.id, radical.radical_char, JSON.stringify(radical.variant_chars), radical.reading, radical.meaning, radical.stroke_count)
    }
  }
  const meta = db.prepare('SELECT id FROM project_meta WHERE id = 1').get()
  if (!meta) {
    db.prepare(`
      INSERT INTO project_meta (id, project_name, ttf_filename, ttf_sha256, ttf_units_per_em, canvas_size, default_stroke_width, stroke_order_standard)
      VALUES (1, '추사 1817', '미등록', ?, ${CANVAS}, ${CANVAS}, ${DEFAULT_STROKE_WIDTH}, 'KR')
    `).run(NO_FONT_SHA256)
  }
}
