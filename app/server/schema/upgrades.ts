import type { DatabaseSync } from 'node:sqlite'
import { transaction } from '../db.ts'
import { CANVAS, DEFAULT_STROKE_WIDTH, KANGXI_COUNT } from '../../shared/constants.ts'
import { ACTION_FONT, ACTOR_FONT, ACTOR_MIGRATION, ACTOR_USER } from '../model.ts'
import type { Pt } from '../../shared/types.ts'
import { CHARACTER_LAYERS_DDL, CONVERSIONS_DDL, ISSUES_DDL, ISSUE_IN_FONT_COLUMN, ISSUE_STATUS_COLUMN, STROKES_DDL, STROKES_HISTORY_DDL, WORKING_DATA_DDL, charactersDdl } from './ddl.ts'

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
  try {
    transaction(db, () => {
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
    })
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
}

function upgradeStrokesTable(db: DatabaseSync) {
  const columns = db.prepare('PRAGMA table_info(strokes)').all() as { name: string }[]
  if (columns.length === 0 || columns.some((column) => column.name === 'radical')) return
  transaction(db, () => {
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
  })
}

// origin CHECK에 'NAVER'가 없는 옛 테이블이면 새 테이블로 갈아끼운다.
function upgradeStrokeOrigins(db: DatabaseSync) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'strokes'`).get() as { sql: string } | undefined
  if (!row || row.sql.includes(`'NAVER'`)) return
  transaction(db, () => {
    db.exec('ALTER TABLE strokes RENAME TO strokes_previous')
    db.exec(STROKES_DDL)
    db.exec('INSERT INTO strokes SELECT * FROM strokes_previous')
    db.exec('DROP TABLE strokes_previous')
  })
}

// kind CHECK에 'OUTLINE'이 없는 옛 character_layers면 새 테이블로 갈아끼운다.
function upgradeLayerKinds(db: DatabaseSync) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'character_layers'`).get() as { sql: string } | undefined
  if (!row || row.sql.includes(`'OUTLINE'`)) return
  transaction(db, () => {
    db.exec('ALTER TABLE character_layers RENAME TO character_layers_previous')
    db.exec(CHARACTER_LAYERS_DDL)
    db.exec('INSERT INTO character_layers SELECT * FROM character_layers_previous')
    db.exec('DROP TABLE character_layers_previous')
  })
}

function dropStatusColumn(db: DatabaseSync) {
  const columns = db.prepare('PRAGMA table_info(characters)').all() as { name: string }[]
  if (!columns.some((column) => column.name === 'status')) return
  db.exec('DROP INDEX IF EXISTS idx_characters_status')
  db.exec('ALTER TABLE characters DROP COLUMN status')
}

// AnimCJK는 참고 출처에서 제거됐다(docs/references/animcjk.md). 옛 DB를 읽는 마이그레이션이라 여기에서만 옛 이름을 쓴다.
const LEGACY_ACJK = 'ACJK'
const LEGACY_ACJK_LAYER_ID = 'acjk'
const LEGACY_ACJK_ACTOR = 'system:acjk'
// 작업자 기록은 사람이 아니라 마이그레이션이 바꾼 것으로 남긴다. 출처가 ACJK였던 획은 출처를 알 수 없는 수작업으로 본다.
const RETIRED_ORIGIN = 'MANUAL'

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((info) => info.name === column)
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table))
}

// AnimCJK의 값 흔적(수신 원본, 레이어 행, 작업자·출처 값)을 지운다. CHECK가 ACJK를 아직 허용하는 옛 표에서도 안전하고 여러 번 실행해도 같다.
function retireAcjkData(db: DatabaseSync) {
  transaction(db, () => {
    if (tableExists(db, 'reference_data')) db.prepare('DELETE FROM reference_data WHERE source = ?').run(LEGACY_ACJK)
    if (tableExists(db, 'character_layers')) db.prepare('DELETE FROM character_layers WHERE layer_id = ? OR kind = ?').run(LEGACY_ACJK_LAYER_ID, LEGACY_ACJK)
    for (const table of ['strokes', 'strokes_history']) {
      if (tableHasColumn(db, table, 'origin')) db.prepare(`UPDATE ${table} SET origin = ? WHERE origin = ?`).run(RETIRED_ORIGIN, LEGACY_ACJK)
    }
    for (const [table, column] of [['characters', 'last_modified_by'], ['strokes', 'last_modified_by'], ['working_data', 'last_modified_by'], ['strokes_history', 'state_modified_by'], ['strokes_history', 'changed_by']]) {
      if (tableHasColumn(db, table, column)) db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(ACTOR_MIGRATION, LEGACY_ACJK_ACTOR)
    }
  })
}

// CHECK 제약에 ACJK가 남은 표를 새 표로 갈아끼운다(SQLite는 CHECK를 바꿀 수 없다).
function rebuildWithoutAcjk(db: DatabaseSync, table: string, ddl: string) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) as { sql: string } | undefined
  if (!row || !row.sql.includes(`'${LEGACY_ACJK}'`)) return
  transaction(db, () => {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_previous`)
    db.exec(ddl)
    db.exec(`INSERT INTO ${table} SELECT * FROM ${table}_previous`)
    db.exec(`DROP TABLE ${table}_previous`)
  })
}

// 옛 형식 DB를 지금 형식으로 맞춘다. 각 단계가 sqlite_master/table_info를 검사해 이미 맞으면 건너뛰므로 여러 번 실행해도 안전하다.
export function upgradeToV2(db: DatabaseSync) {
  retireAcjkData(db)
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
    ${CHARACTER_LAYERS_DDL};
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
  upgradeLayerKinds(db)
  addColumn(db, 'reference_data', 'source_url', 'TEXT')
  splitRadicalNames(db)
  migrateEditHistory(db)
  introduceWorkingData(db)
}

// 변환 이력(conversions)을 추가한다. CREATE ... IF NOT EXISTS라 여러 번 실행해도 안전하다.
export function upgradeToV3(db: DatabaseSync) {
  db.exec(CONVERSIONS_DDL)
}

// 참고 출처에서 AnimCJK를 제거한다: 수신 원본·레이어 행·값 흔적을 지우고, strokes.origin과 character_layers.kind의 CHECK에서 ACJK를 뺀다.
export function upgradeToV4(db: DatabaseSync) {
  retireAcjkData(db)
  rebuildWithoutAcjk(db, 'strokes', STROKES_DDL)
  rebuildWithoutAcjk(db, 'character_layers', CHARACTER_LAYERS_DDL)
}

// 작업 데이터(working_data)를 도입하면서, strokes에 있던 IDS·Ollama·수작업 초안을 승인 대기 작업 데이터로 되돌린다.
// 처음 한 번만 한다(이후 승인한 글자는 같은 origin으로 strokes에 있어야 한다). 되돌리기 전 strokes 행은 이력에 남긴다.
// 궁서체 글리프 유무(in_font)는 폰트를 읽어야 알 수 있어 여기서는 0으로 둔다.
function introduceWorkingData(db: DatabaseSync) {
  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'working_data'`).get()) return
  addColumn(db, 'issues', 'status', ISSUE_STATUS_COLUMN)
  addColumn(db, 'issues', 'in_font', ISSUE_IN_FONT_COLUMN)
  const drafts = `FROM strokes WHERE origin IN ('IDS', 'OLLAMA_IDS', 'MANUAL')`
  transaction(db, () => {
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
  })
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
  transaction(db, () => {
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
  })
}

// 옛 name_kr('훈 음', 공백 하나)을 reading(음)과 meaning(훈)으로 나눠 새 테이블로 갈아끼운다.
function splitRadicalNames(db: DatabaseSync) {
  const columns = db.prepare('PRAGMA table_info(radicals)').all() as { name: string }[]
  if (!columns.some((column) => column.name === 'name_kr')) return
  transaction(db, () => {
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
  })
}

function addColumn(db: DatabaseSync, table: string, name: string, type: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
}
