import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { KANGXI_RADICALS } from './radicals.ts'
import {
  CANVAS,
  COORD_ROUND,
  DB_BUSY_TIMEOUT_MS,
  DEFAULT_STROKE_WIDTH,
  FETCH_TIMEOUT_MS,
  HISTORY_KEEP,
  KANGXI_COUNT,
  KANJI_HEX_PAD,
  KANJIVG_UNITS,
  MIN_STROKE_WIDTH,
  MISSING_FETCH_LIMIT,
  OLLAMA_TIMEOUT_MS,
  SHA256_HEX_LENGTH,
  STROKE_WIDTH_CAP_RATIO,
  SVG_FALLBACK_MAX,
  SVG_FALLBACK_MIN,
  SVG_SAMPLE_STEP,
  UNICODE_HEX_PAD,
} from '../src/lib/constants.ts'

const HANZI_VERSION = 'hanzi-writer-data@2.0'
const HANZI_CDN = 'https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0'
const KANJIVG_VERSION = 'kanjivg@master'
const KANJIVG_CDN = 'https://cdn.jsdelivr.net/gh/KanjiVG/kanjivg@master/kanji'
const KIBIBYTE = 1024
const FETCH_LIMIT = 512 * KIBIBYTE

const KR_ORDER_REVIEW = new Set(['必', '右', '有', '布', '左', '王', '玉', '主', '生', '靑', '青', '火', '爲', '為', '登', '發', '皮', '馬', '門', '臣', '母', '舟', '車', '戈', '成', '我', '感'])

const IDS_BOOK: Record<string, { ids: string; parts: { char: string; box: [number, number, number, number] }[] }> = {
  畓: { ids: '⿱水田', parts: [{ char: '水', box: [0.12, 0.5, 0.88, 1] }, { char: '田', box: [0.12, 0, 0.88, 0.5] }] },
}

type Pt = [number, number]

type StrokeRow = {
  stroke_order: number
  outline_path: string
  median_points: string
  stroke_width: number
  is_radical: number
  start_cap_type: string
  end_cap_type: string
}

export type Workspace = ReturnType<typeof createWorkspace>

let singleton: Workspace | null = null

export function getWorkspace(rootDir: string): Workspace {
  if (!singleton) singleton = createWorkspace(rootDir)
  return singleton
}

function createWorkspace(rootDir: string) {
  const dbPath = path.join(rootDir, 'database', 'chusa1817.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const compiledDir = path.join(rootDir, 'output', 'compiled')
  fs.mkdirSync(compiledDir, { recursive: true })

  const db = new DatabaseSync(dbPath)
  opened = db
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`)
  migrate(db)
  seed(db)

  function listCharacters(query: string) {
    const q = query.trim()
    const rows = db.prepare(`
      SELECT unicode, char, grade, status, issue_reason, ref_source, radical_id, radical_form,
             korean_reading, stroke_count, updated_at
      FROM characters
      ORDER BY unicode
    `).all() as Record<string, unknown>[]
    if (!q) return rows
    return rows.filter((row) => {
      const char = String(row.char)
      const reading = String(row.korean_reading ?? '')
      const unicode = String(row.unicode)
      return char.includes(q) || reading.includes(q) || unicode.toLowerCase().includes(q.toLowerCase())
    })
  }

  function getCharacter(unicode: string) {
    const row = db.prepare('SELECT * FROM characters WHERE unicode = ?').get(unicode) as Record<string, unknown> | undefined
    if (!row) return null
    const strokes = (db.prepare(`
      SELECT stroke_order, outline_path, median_points, stroke_width, is_radical, start_cap_type, end_cap_type
      FROM strokes WHERE unicode = ? ORDER BY stroke_order
    `).all(unicode) as StrokeRow[]).map((stroke) => ({
      ...stroke,
      median_points: JSON.parse(stroke.median_points) as Pt[],
      is_radical: stroke.is_radical ? 1 : 0,
    }))
    const history = db.prepare('SELECT COUNT(*) AS n FROM edit_history WHERE unicode = ?').get(unicode) as { n: number }
    return {
      ...row,
      compiled_json: row.compiled_json ? JSON.parse(String(row.compiled_json)) : null,
      strokes,
      history_count: history.n,
    }
  }

  function updateStrokes(unicode: string, strokes: {
    outline_path: string
    median_points: Pt[]
    stroke_width: number
    is_radical: number
    start_cap_type: string
    end_cap_type: string
  }[], action: string) {
    const current = getCharacter(unicode)
    if (!current) throw new Error('등록되지 않은 글자입니다.')
    remember(unicode, current, action)
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM strokes WHERE unicode = ?').run(unicode)
      const insert = db.prepare(`
        INSERT INTO strokes (unicode, stroke_order, outline_path, median_points, stroke_width, is_radical, start_cap_type, end_cap_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      strokes.forEach((stroke, index) => {
        if (!Array.isArray(stroke.median_points) || stroke.median_points.length < 2) {
          throw new Error(`${index + 1}획의 중심선이 없습니다.`)
        }
        insert.run(
          unicode,
          index + 1,
          stroke.outline_path,
          JSON.stringify(roundPoints(stroke.median_points)),
          clampWidth(stroke.stroke_width),
          stroke.is_radical ? 1 : 0,
          cap(stroke.start_cap_type),
          cap(stroke.end_cap_type),
        )
      })
      db.prepare(`
        UPDATE characters SET stroke_count = ?, status = CASE WHEN status = 'DONE' THEN 'AUTO_MATCHED' ELSE status END, compiled_json = NULL, compiled_hash = NULL
        WHERE unicode = ?
      `).run(strokes.length, unicode)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    trimHistory(unicode)
    return getCharacter(unicode)
  }

  function undo(unicode: string) {
    const row = db.prepare(`
      SELECT id, snapshot_json FROM edit_history WHERE unicode = ? ORDER BY id DESC LIMIT 1
    `).get(unicode) as { id: number; snapshot_json: string } | undefined
    if (!row) throw new Error('되돌릴 편집이 없습니다.')
    const snapshot = JSON.parse(row.snapshot_json) as { strokes: StrokeRow[] }
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM strokes WHERE unicode = ?').run(unicode)
      const insert = db.prepare(`
        INSERT INTO strokes (unicode, stroke_order, outline_path, median_points, stroke_width, is_radical, start_cap_type, end_cap_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const stroke of snapshot.strokes) {
        insert.run(unicode, stroke.stroke_order, stroke.outline_path, stroke.median_points, stroke.stroke_width, stroke.is_radical, stroke.start_cap_type, stroke.end_cap_type)
      }
      db.prepare('UPDATE characters SET stroke_count = ?, compiled_json = NULL, compiled_hash = NULL WHERE unicode = ?')
        .run(snapshot.strokes.length, unicode)
      db.prepare('DELETE FROM edit_history WHERE id = ?').run(row.id)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return getCharacter(unicode)
  }

  async function ensureReference(unicode: string) {
    const character = db.prepare('SELECT unicode, char FROM characters WHERE unicode = ?').get(unicode) as { unicode: string; char: string } | undefined
    if (!character) throw new Error('등록되지 않은 글자입니다.')
    const count = db.prepare('SELECT COUNT(*) AS n FROM strokes WHERE unicode = ?').get(unicode) as { n: number }
    if (count.n > 0) {
      const hanzi = await loadSource(unicode, 'MMH', hanziUrl(character.char), () => fetchHanzi(character.char))
      if (hanzi && hanzi.value.medians.length === count.n) {
        const update = db.prepare('UPDATE strokes SET median_points = ? WHERE unicode = ? AND stroke_order = ?')
        hanzi.value.medians.forEach((median, index) => update.run(JSON.stringify(roundPoints(median)), unicode, index + 1))
        const radical = new Set(hanzi.value.radical)
        const mark = db.prepare('UPDATE strokes SET is_radical = ? WHERE unicode = ? AND stroke_order = ?')
        for (let index = 0; index < count.n; index++) mark.run(radical.has(index) ? 1 : 0, unicode, index + 1)
        db.prepare(`UPDATE characters SET ref_source = 'MMH', ref_url = ? WHERE unicode = ?`).run(hanzi.url, unicode)
      }
      return { unicode, source: hanzi ? 'MMH' : 'DB', fetched: false }
    }

    const hanzi = await loadSource(unicode, 'MMH', hanziUrl(character.char), () => fetchHanzi(character.char))
    if (hanzi) {
      saveImported(unicode, 'MMH', hanzi.url, hanzi.value.medians, hanzi.value.medians.map((median) => ribbonPath(median, DEFAULT_STROKE_WIDTH)), hanzi.value.radical)
      return { unicode, source: 'MMH', fetched: true }
    }
    const kanjiUrl = kanjiVgUrl(character.char)
    const kanji = await loadSource(unicode, 'KANJIVG', kanjiUrl, () => fetchKanjiVg(character.char))
    if (kanji) {
      saveImported(unicode, 'KANJIVG', kanji.url, kanji.value.medians, kanji.value.medians.map((median) => ribbonPath(median, DEFAULT_STROKE_WIDTH)), kanji.value.radical)
      return { unicode, source: 'KANJIVG', fetched: true }
    }
    const composed = await composeIds(character.char)
    if (!composed) {
      db.prepare(`UPDATE characters SET status = 'ISSUE', issue_reason = ? WHERE unicode = ?`)
        .run('Hanzi, KanjiVG, IDS 합성 모두 실패', unicode)
      return { unicode, source: 'NONE', fetched: false }
    }
    const idsUrl = composed.source === 'OLLAMA' ? OLLAMA_URL : null
    saveImported(unicode, 'OLLAMA_IDS', idsUrl, composed.medians, composed.medians.map((median) => ribbonPath(median, DEFAULT_STROKE_WIDTH)), [])
    db.prepare(`UPDATE characters SET ids_structure = ?, ids_source = ?, ref_source = 'OLLAMA_IDS', ref_url = ?, status = 'AI_ASSISTED' WHERE unicode = ?`)
      .run(composed.ids, composed.source, idsUrl, unicode)
    return { unicode, source: composed.source, fetched: true }
  }

  async function syncMissing(limit = MISSING_FETCH_LIMIT) {
    const rows = db.prepare(`
      SELECT c.unicode FROM characters c
      WHERE NOT EXISTS (SELECT 1 FROM strokes s WHERE s.unicode = c.unicode)
      ORDER BY c.unicode LIMIT ?
    `).all(limit) as { unicode: string }[]
    const results = []
    for (const row of rows) results.push(await ensureReference(row.unicode))
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return { tried: results.length, results }
  }

  function compile(unicode: string) {
    const detail = getCharacter(unicode)
    if (!detail) throw new Error('등록되지 않은 글자입니다.')
    const strokes = detail.strokes as { stroke_order: number; outline_path: string; median_points: Pt[]; stroke_width: number; is_radical: number }[]
    const problems = validate(String(detail.char), strokes)
    if (problems.length) {
      db.prepare(`UPDATE characters SET status = 'ISSUE', issue_reason = ? WHERE unicode = ?`).run(problems.join(' '), unicode)
      throw new Error(problems.join(' '))
    }
    const radical = radicalOf(detail.radical_id as number | null, detail.radical_form as string | null, strokes)
    const compiled = {
      schemaVersion: 1 as const,
      character: detail.char,
      unicode,
      reading: detail.korean_reading ?? '',
      strokeCount: strokes.length,
      coordinateSystem: { size: CANVAS, yAxis: 'up' as const },
      radical,
      fullOutline: strokes.map((stroke) => stroke.outline_path).join(' '),
      strokes: strokes.map((stroke) => stroke.outline_path),
      medians: strokes.map((stroke) => stroke.median_points),
      strokeWidths: strokes.map((stroke) => stroke.stroke_width),
      source: { outline: String(detail.ref_url || detail.ref_source), medians: String(detail.ref_url || detail.ref_source) },
    }
    const hash = createHash('sha256').update(JSON.stringify(compiled.strokes) + JSON.stringify(compiled.medians)).digest('hex')
    db.prepare(`UPDATE characters SET compiled_json = ?, compiled_hash = ?, compiled_at = CURRENT_TIMESTAMP, status = 'AUTO_MATCHED', issue_reason = NULL WHERE unicode = ?`)
      .run(JSON.stringify(compiled), hash, unicode)
    const file = charFile(compiledDir, String(detail.char))
    fs.writeFileSync(file, `${JSON.stringify(compiled)}\n`)
    return compiled
  }

  function listRadicals() {
    return db.prepare('SELECT id, radical_char, variant_chars, name_kr, stroke_count FROM radicals ORDER BY id').all()
  }

  function setStatus(unicode: string, status: string) {
    const row = db.prepare('SELECT char FROM characters WHERE unicode = ?').get(unicode) as { char: string } | undefined
    if (!row) throw new Error('등록되지 않은 글자입니다.')
    if (!['TODO', 'AUTO_MATCHED', 'AI_ASSISTED', 'ISSUE', 'DONE'].includes(status)) throw new Error('알 수 없는 상태입니다.')
    if (status === 'DONE' && KR_ORDER_REVIEW.has(row.char)) {
      throw new Error('한국 필순 검수가 필요한 글자는 검수 전 완료로 둘 수 없습니다.')
    }
    db.prepare('UPDATE characters SET status = ?, issue_reason = NULL WHERE unicode = ?').run(status, unicode)
    return getCharacter(unicode)
  }

  function importInitial(entries: unknown) {
    const count = db.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number }
    if (count.n > 0) throw new Error('이미 글자가 있습니다. 초기 파일은 비어 있을 때만 올릴 수 있습니다.')
    if (!Array.isArray(entries)) throw new Error('글자 목록은 배열이어야 합니다.')
    const seen = new Set<string>()
    let imported = 0
    db.exec('BEGIN')
    try {
      const insertChar = db.prepare(`
        INSERT INTO characters (unicode, char, korean_reading, status, ref_source, raw_ttf_path, stroke_count)
        VALUES (?, ?, ?, 'TODO', 'NONE', '', 0)
      `)
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue
        const char = String((entry as { 한자?: unknown }).한자 ?? '').trim()
        if ([...char].length !== 1 || seen.has(char)) continue
        seen.add(char)
        insertChar.run(unicodeOf(char), char, String((entry as { 음?: unknown }).음 ?? ''))
        imported += 1
      }
      if (imported === 0) throw new Error('올릴 글자가 없습니다. 한자 한 글자와 음이 있는 목록이어야 합니다.')
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { imported }
  }

  return { listCharacters, getCharacter, updateStrokes, undo, ensureReference, syncMissing, compile, listRadicals, setStatus, importInitial }

  async function loadSource<T>(unicode: string, source: 'MMH' | 'KANJIVG', url: string, fetchFresh: () => Promise<Remote<T>>): Promise<Remote<T> | null> {
    const cached = db.prepare('SELECT found, raw_data, source_url FROM reference_data WHERE unicode = ? AND source = ?')
      .get(unicode, source) as { found: number; raw_data: string | null; source_url: string | null } | undefined
    if (cached) {
      if (!cached.source_url) db.prepare('UPDATE reference_data SET source_url = ? WHERE unicode = ? AND source = ?').run(url, unicode, source)
      if (!cached.found || !cached.raw_data) return null
      const value = (source === 'MMH' ? parseHanzi(cached.raw_data) : parseKanjiVg(cached.raw_data) ?? parseHanzi(cached.raw_data)) as T | null
      return value ? { url: cached.source_url || url, raw: cached.raw_data, value } : null
    }
    try {
      const fresh = await fetchFresh()
      db.prepare(`
        INSERT INTO reference_data (unicode, source, source_version, source_url, raw_data, raw_sha256, found)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        unicode,
        source,
        source === 'MMH' ? HANZI_VERSION : KANJIVG_VERSION,
        fresh.url,
        fresh.value ? fresh.raw : null,
        fresh.value ? createHash('sha256').update(fresh.raw).digest('hex') : null,
        fresh.value ? 1 : 0,
      )
      return fresh.value ? fresh : null
    } catch {
      return null
    }
  }

  function saveImported(unicode: string, source: string, url: string | null, medians: Pt[][], outlines: string[], radical: number[]) {
    const radicalSet = new Set(radical)
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM strokes WHERE unicode = ?').run(unicode)
      const insert = db.prepare(`
        INSERT INTO strokes (unicode, stroke_order, outline_path, median_points, stroke_width, is_radical, start_cap_type, end_cap_type)
        VALUES (?, ?, ?, ?, ?, ?, 'NONE', 'NONE')
      `)
      medians.forEach((median, index) => {
        insert.run(unicode, index + 1, outlines[index] || ribbonPath(median, DEFAULT_STROKE_WIDTH), JSON.stringify(roundPoints(median)), DEFAULT_STROKE_WIDTH, radicalSet.has(index) ? 1 : 0)
      })
      db.prepare(`UPDATE characters SET stroke_count = ?, ref_source = ?, ref_url = ?, status = 'AUTO_MATCHED', issue_reason = NULL WHERE unicode = ?`)
        .run(medians.length, source === 'OLLAMA_IDS' ? 'OLLAMA_IDS' : source, url, unicode)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  async function composeIds(char: string): Promise<{ ids: string; source: 'MANUAL' | 'OLLAMA'; medians: Pt[][] } | null> {
    const known = IDS_BOOK[char]
    const spec = known ?? await askOllama(char)
    if (!spec) return null
    const medians: Pt[][] = []
    for (const part of spec.parts) {
      const component = db.prepare('SELECT unicode FROM characters WHERE char = ?').get(part.char) as { unicode: string } | undefined
      if (!component) return null
      const rows = db.prepare('SELECT median_points FROM strokes WHERE unicode = ? ORDER BY stroke_order').all(component.unicode) as { median_points: string }[]
      if (rows.length === 0) return null
      for (const row of rows) medians.push(fitMedian(JSON.parse(row.median_points) as Pt[], part.box))
    }
    return { ids: spec.ids, source: known ? 'MANUAL' : 'OLLAMA', medians }
  }
}

function migrate(db: DatabaseSync) {
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
      name_kr TEXT NOT NULL,
      stroke_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS characters (
      unicode TEXT PRIMARY KEY,
      char TEXT NOT NULL UNIQUE,
      grade TEXT,
      status TEXT NOT NULL DEFAULT 'TODO',
      issue_reason TEXT,
      raw_ttf_path TEXT,
      ref_source TEXT NOT NULL DEFAULT 'NONE',
      ref_url TEXT,
      radical_id INTEGER REFERENCES radicals(id),
      radical_form TEXT,
      korean_reading TEXT,
      ids_structure TEXT,
      ids_source TEXT,
      ai_stroke_count INTEGER,
      stroke_count INTEGER NOT NULL DEFAULT 0,
      compiled_json TEXT,
      compiled_hash TEXT,
      compiled_at DATETIME,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS strokes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unicode TEXT NOT NULL,
      stroke_order INTEGER NOT NULL,
      outline_path TEXT NOT NULL,
      median_points TEXT NOT NULL,
      stroke_width INTEGER NOT NULL DEFAULT ${DEFAULT_STROKE_WIDTH},
      is_radical INTEGER NOT NULL DEFAULT 0,
      start_cap_type TEXT NOT NULL DEFAULT 'NONE',
      end_cap_type TEXT NOT NULL DEFAULT 'NONE',
      FOREIGN KEY (unicode) REFERENCES characters(unicode) ON DELETE CASCADE,
      UNIQUE (unicode, stroke_order)
    );
    CREATE TABLE IF NOT EXISTS edit_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      unicode TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      action_desc TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (unicode) REFERENCES characters(unicode) ON DELETE CASCADE
    );
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
    CREATE INDEX IF NOT EXISTS idx_characters_status ON characters(status);
    CREATE INDEX IF NOT EXISTS idx_edit_history_unicode_time ON edit_history(unicode, created_at DESC);
    CREATE TRIGGER IF NOT EXISTS trg_characters_updated AFTER UPDATE ON characters
    WHEN NEW.updated_at = OLD.updated_at
    BEGIN
      UPDATE characters SET updated_at = CURRENT_TIMESTAMP WHERE unicode = NEW.unicode;
    END;
  `)
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (!version.user_version) db.exec('PRAGMA user_version = 1')
  addColumn(db, 'characters', 'ref_url', 'TEXT')
  addColumn(db, 'reference_data', 'source_url', 'TEXT')
}

function addColumn(db: DatabaseSync, table: string, name: string, type: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  if (!columns.some((column) => column.name === name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
}

function seed(db: DatabaseSync) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM radicals').get() as { n: number }
  if (count.n === 0) {
    const insert = db.prepare('INSERT INTO radicals (id, radical_char, variant_chars, name_kr, stroke_count) VALUES (?, ?, ?, ?, ?)')
    for (const radical of KANGXI_RADICALS) {
      insert.run(radical.id, radical.radical_char, JSON.stringify(radical.variant_chars), radical.name_kr, radical.stroke_count)
    }
  }
  const meta = db.prepare('SELECT id FROM project_meta WHERE id = 1').get()
  if (!meta) {
    db.prepare(`
      INSERT INTO project_meta (id, project_name, ttf_filename, ttf_sha256, ttf_units_per_em, canvas_size, default_stroke_width, stroke_order_standard)
      VALUES (1, '추사 1817', '미등록', ?, ${CANVAS}, ${CANVAS}, ${DEFAULT_STROKE_WIDTH}, 'KR')
    `).run('0'.repeat(SHA256_HEX_LENGTH))
  }
}

const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate'

type Remote<T> = { url: string; raw: string; value: T | null }
type HanziGlyph = { medians: Pt[][]; outlines: string[]; radical: number[] }
type KanjiGlyph = { medians: Pt[][]; radical: number[] }

function hanziUrl(char: string): string {
  return `${HANZI_CDN}/${encodeURIComponent(char)}.json`
}

function kanjiVgUrl(char: string): string {
  return `${KANJIVG_CDN}/${char.codePointAt(0)!.toString(16).padStart(KANJI_HEX_PAD, '0')}.svg`
}

async function fetchHanzi(char: string): Promise<Remote<HanziGlyph>> {
  const url = hanziUrl(char)
  const response = await fetchLimited(url)
  if (response.status === 404) return { url, raw: '', value: null }
  if (!response.ok) throw new Error(`Hanzi 응답 ${response.status}`)
  return { url, raw: response.text, value: parseHanzi(response.text) }
}

function parseHanzi(text: string): HanziGlyph | null {
  try {
    const data = JSON.parse(text) as { medians?: unknown; strokes?: unknown; outlines?: unknown; radStrokes?: unknown; radical?: unknown }
    const medians = Array.isArray(data.medians) ? data.medians.map(asPoints).filter((points) => points.length >= 2) : []
    const strokeList = Array.isArray(data.strokes) ? data.strokes : data.outlines
    const outlines = Array.isArray(strokeList) ? strokeList.filter((item): item is string => typeof item === 'string') : []
    const radicalSource = Array.isArray(data.radStrokes) ? data.radStrokes : data.radical
    const radical = Array.isArray(radicalSource) ? radicalSource.map(Number).filter(Number.isInteger) : []
    return medians.length ? { medians, outlines, radical } : null
  } catch {
    return null
  }
}

async function fetchKanjiVg(char: string): Promise<Remote<KanjiGlyph>> {
  const url = kanjiVgUrl(char)
  const response = await fetchLimited(url)
  if (response.status === 404) return { url, raw: '', value: null }
  if (!response.ok) throw new Error(`KanjiVG 응답 ${response.status}`)
  return { url, raw: response.text, value: parseKanjiVg(response.text) }
}

function parseKanjiVg(svg: string): { medians: Pt[][]; radical: number[] } | null {
  const paths: { id: string; d: string }[] = []
  for (const match of svg.matchAll(/<path\b([^>]*)>/g)) {
    const attrs = match[1]
    const id = /id="([^"]+)"/.exec(attrs)?.[1] ?? ''
    const d = /d="([^"]+)"/.exec(attrs)?.[1] ?? ''
    if (/-s\d+$/.test(id) && /^[MLHVCSQTZmlhvcsqtz0-9.,\s-]+$/.test(d)) paths.push({ id, d })
  }
  if (paths.length === 0) return null
  paths.sort((a, b) => strokeNo(a.id) - strokeNo(b.id))
  return {
    medians: paths.map((item) => sampleSvg(item.d).map(kanjiPoint)),
    radical: paths.flatMap((item, index) => radicalGroup(svg, item.id) ? [index] : []),
  }
}

function radicalGroup(svg: string, id: string): boolean {
  const at = svg.indexOf(`id="${id}"`)
  if (at < 0) return false
  const before = svg.slice(0, at)
  const opens = [...before.matchAll(/<g\b[^>]*>/g)]
  const closes = [...before.matchAll(/<\/g>/g)]
  const depth = opens.length - closes.length
  return opens.slice(-Math.max(depth, 1)).some((match) => /kvg:radical="/.test(match[0]))
}

function strokeNo(id: string): number {
  return Number(/-s(\d+)$/.exec(id)?.[1] ?? 0)
}

function sampleSvg(d: string): Pt[] {
  const nums = d.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? []
  const pts: Pt[] = []
  for (let i = 0; i + 1 < nums.length; i += SVG_SAMPLE_STEP) pts.push([nums[i], nums[i + 1]])
  if (pts.length < 2 && nums.length >= 4) pts.push([nums[0], nums[1]], [nums[nums.length - 2], nums[nums.length - 1]])
  return pts.length >= 2 ? pts : [[SVG_FALLBACK_MIN, SVG_FALLBACK_MIN], [SVG_FALLBACK_MAX, SVG_FALLBACK_MAX]]
}

function kanjiPoint(point: Pt): Pt {
  const scale = CANVAS / KANJIVG_UNITS
  return [round1(point[0] * scale), round1((KANJIVG_UNITS - point[1]) * scale)]
}

async function askOllama(char: string): Promise<{ ids: string; parts: { char: string; box: [number, number, number, number] }[] } | null> {
  try {
    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen2.5:14b',
        stream: false,
        options: { temperature: 0 },
        prompt: `한자 ${char}의 IDS만 JSON으로 답하라. {"ids":"⿰木木","parts":[{"char":"木","box":[0,0,0.5,1]},{"char":"木","box":[0.5,0,1,1]}]}`,
      }),
    })
    if (!response.ok) return null
    const data = await response.json() as { response?: string }
    const match = data.response?.match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0]) as { ids?: string; parts?: { char?: string; box?: number[] }[] }
    if (!parsed.ids || !Array.isArray(parsed.parts)) return null
    const parts = parsed.parts.flatMap((part) => {
      if (!part.char || [...part.char].length !== 1 || !part.box || part.box.length !== 4) return []
      const box = part.box.map(Number) as [number, number, number, number]
      if (box.some((value) => value < 0 || value > 1)) return []
      return [{ char: part.char, box }]
    })
    return parts.length ? { ids: parsed.ids, parts } : null
  } catch {
    return null
  }
}

function fitMedian(median: Pt[], box: [number, number, number, number]): Pt[] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of median) {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  const [x0, y0, x1, y1] = box
  return median.map(([x, y]) => [
    round1((x0 + ((x - minX) / Math.max(1, maxX - minX)) * (x1 - x0)) * CANVAS),
    round1((y0 + ((y - minY) / Math.max(1, maxY - minY)) * (y1 - y0)) * CANVAS),
  ])
}

function ribbonPath(median: Pt[], width: number): string {
  const left: Pt[] = []
  const right: Pt[] = []
  const radius = width / 2
  for (let i = 0; i < median.length; i++) {
    const prev = median[Math.max(0, i - 1)]
    const next = median[Math.min(median.length - 1, i + 1)]
    const len = Math.hypot(next[0] - prev[0], next[1] - prev[1]) || 1
    const nx = -(next[1] - prev[1]) / len
    const ny = (next[0] - prev[0]) / len
    left.push([median[i][0] + nx * radius, median[i][1] + ny * radius])
    right.push([median[i][0] - nx * radius, median[i][1] - ny * radius])
  }
  const points = [...left, ...right.reverse()]
  return `M${points.map((point) => `${round1(point[0])} ${round1(point[1])}`).join(' L')} Z`
}

function validate(_char: string, strokes: { outline_path: string; median_points: Pt[]; is_radical: number }[]): string[] {
  const problems: string[] = []
  if (strokes.length === 0) problems.push('획이 없습니다.')
  strokes.forEach((stroke, index) => {
    if (stroke.median_points.length < 2) problems.push(`${index + 1}획 중심선이 짧습니다.`)
    if (!/^[MLQCZmlqcz0-9.,\s-]+$/.test(stroke.outline_path) || !/[Zz]\s*$/.test(stroke.outline_path.trim())) {
      problems.push(`${index + 1}획 경로가 올바르지 않습니다.`)
    }
  })
  return problems
}

function radicalOf(id: number | null, form: string | null, strokes: { is_radical: number }[]) {
  if (!id) return null
  const radical = KANGXI_RADICALS.find((item) => item.id === id)
  if (!radical) return null
  return {
    id,
    char: form || radical.radical_char,
    origin: form && form !== radical.radical_char ? radical.radical_char : null,
    name: radical.name_kr,
    strokeIndices: strokes.flatMap((stroke, index) => stroke.is_radical ? [index] : []),
  }
}

function remember(unicode: string, current: { strokes: unknown }, action: string) {
  const strokes = (current.strokes as { median_points: Pt[] }[]).map((stroke) => ({
    ...stroke,
    median_points: JSON.stringify(stroke.median_points),
  }))
  dbInsertHistory(unicode, JSON.stringify({ strokes }), action)
}

function dbInsertHistory(unicode: string, snapshot: string, action: string) {
  const db = singletonDb()
  db.prepare('INSERT INTO edit_history (unicode, snapshot_json, action_desc) VALUES (?, ?, ?)').run(unicode, snapshot, action)
}

function trimHistory(unicode: string) {
  singletonDb().prepare(`
    DELETE FROM edit_history WHERE unicode = ? AND id NOT IN (
      SELECT id FROM edit_history WHERE unicode = ? ORDER BY id DESC LIMIT ${HISTORY_KEEP}
    )
  `).run(unicode, unicode)
}

let opened: DatabaseSync | null = null
function singletonDb(): DatabaseSync {
  if (!opened) throw new Error('DB가 아직 열리지 않았습니다.')
  return opened
}

function unicodeOf(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(UNICODE_HEX_PAD, '0')}`
}

function roundPoints(points: Pt[]): Pt[] {
  return points.map(([x, y]) => [round1(x), round1(y)])
}

function round1(value: number): number {
  return Math.round(value * COORD_ROUND) / COORD_ROUND
}

function clampWidth(value: number): number {
  return Math.max(MIN_STROKE_WIDTH, Math.min(Math.round(DEFAULT_STROKE_WIDTH * STROKE_WIDTH_CAP_RATIO), Math.round(value) || DEFAULT_STROKE_WIDTH))
}

function cap(value: string): string {
  return value === 'AUTO_ROUND' || value === 'REF_STAMP' ? value : 'NONE'
}

function asPoints(value: unknown): Pt[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((point) => {
    if (!Array.isArray(point) || point.length < 2) return []
    const x = Number(point[0])
    const y = Number(point[1])
    return Number.isFinite(x) && Number.isFinite(y) ? [[x, y] as Pt] : []
  })
}

function charFile(dir: string, char: string): string {
  if ([...char].length !== 1) throw new Error('한자 1자만 저장할 수 있습니다.')
  const file = path.resolve(dir, `${char}.json`)
  if (!file.startsWith(path.resolve(dir) + path.sep)) throw new Error('경로가 올바르지 않습니다.')
  return file
}

async function fetchLimited(url: string): Promise<{ status: number; ok: boolean; text: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const text = await response.text()
  if (text.length > FETCH_LIMIT) throw new Error('응답이 너무 큽니다.')
  return { status: response.status, ok: response.ok, text }
}

