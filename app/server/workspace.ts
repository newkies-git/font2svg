import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { KANGXI_RADICALS } from './radicals.ts'
import {
  AREA_FLATNESS,
  CANVAS,
  COORD_ROUND,
  DB_BUSY_TIMEOUT_MS,
  DEFAULT_STROKE_WIDTH,
  FETCH_TIMEOUT_MS,
  FONT_BATCH_LIMIT,
  HISTORY_KEEP,
  IDS_FILE_LIMIT,
  IDS_MAX_DEPTH,
  KANGXI_COUNT,
  MAX_COVERED_AREA_RATIO,
  MEDIAN_BBOX_INSET,
  MEDIAN_MIN_POINTS,
  MEDIAN_SIMPLIFY_TOLERANCE,
  MIN_COVERED_AREA_RATIO,
  MIN_STROKE_AREA_RATIO,
  MIN_STROKE_WIDTH,
  MISSING_FETCH_LIMIT,
  OLLAMA_TIMEOUT_MS,
  SHA256_HEX_LENGTH,
  STROKE_WIDTH_CAP_RATIO,
  UNICODE_HEX_PAD,
} from '../src/lib/constants.ts'
import { flattenContours, type Pt as Point } from '../src/lib/paths.ts'
import { computeOptimalStrokeWidth, recoverMedian, segmentOutlineByMedians, simplifyPolyline } from '../src/lib/strokeCut.ts'
import { loadFont, type FontFile } from './font.ts'

const HANJA_VERSION = 'hanzi-writer-data@2.0'
const HANJA_CDN = 'https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0'
const FONT_FILE = path.join('app', 'fonts', 'Gungseouche.ttf')
const KIBIBYTE = 1024
const FETCH_LIMIT = 512 * KIBIBYTE

const KR_ORDER_REVIEW = new Set(['必', '右', '有', '布', '左', '王', '玉', '主', '生', '靑', '青', '火', '爲', '為', '登', '發', '皮', '馬', '門', '臣', '母', '舟', '車', '戈', '成', '我', '感'])

const IDS_URL = 'https://www.babelstone.co.uk/CJK/IDS.TXT'
const IDS_FILE = path.join('database', 'IDS.TXT')
const IDS_HEADER = 'Ideographic Description Sequences'

// 공개 IDS에 없는 글자를 사람이 직접 적어 두는 곳.
const IDS_BOOK: Record<string, string> = {
  畓: '⿱水田',
}

// IDS 부품으로 쓰이는 변형 부수 → DB에 획이 있는 원래 글자.
const LEAF_FORMS: Record<string, string> = {
  亻: '人', 氵: '水', 忄: '心', 扌: '手', 犭: '犬', 礻: '示', 衤: '衣', 刂: '刀', 釒: '金', 艹: '艸', 灬: '火', 辶: '辵', 糹: '糸', 飠: '食',
}

type Pt = [number, number]

const ACTOR_USER = 'user'
const ACTOR_HANJA = 'system:hanja'
const ACTOR_MIGRATION = 'system:migration'
const ACTOR_IDS = 'system:ids'
const ACTOR_FONT = 'system:font'
const ORIGIN_MANUAL = 'MANUAL'

type StrokeOutline = { order: number; path: string; radical: 0 | 1 }
type MedianLine = { order: number; points: Pt[]; width: number; start_cap: string; end_cap: string }

type StrokeItem = {
  outline_path: string
  median_points: Pt[]
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
  let font: FontFile | null | undefined
  let idsIndex: Map<string, string[]> | undefined

  function listCharacters(query: string) {
    const q = query.trim()
    const rows = db.prepare(`
      SELECT c.unicode, c.char, c.grade, c.status, i.reason AS issue_reason, COALESCE(s.origin, 'NONE') AS origin,
             c.reading, c.meaning, c.stroke_count, c.last_modified_at, c.last_modified_by
      FROM characters c
      LEFT JOIN issues i ON i.char = c.char
      LEFT JOIN strokes s ON s.char = c.char
      ORDER BY c.unicode
    `).all() as Record<string, unknown>[]
    if (!q) return rows
    return rows.filter((row) => {
      const char = String(row.char)
      const reading = String(row.reading ?? '')
      const meaning = String(row.meaning ?? '')
      const unicode = String(row.unicode)
      return char.includes(q) || reading.includes(q) || meaning.includes(q) || unicode.toLowerCase().includes(q.toLowerCase())
    })
  }

  function getCharacter(unicode: string) {
    const row = db.prepare('SELECT * FROM characters WHERE unicode = ?').get(unicode) as Record<string, unknown> | undefined
    if (!row) return null
    const strokes = readStrokes(unicode).map((stroke, index) => ({ stroke_order: index + 1, ...stroke }))
    const meta = readStrokeRow(unicode)
    const history = db.prepare('SELECT COUNT(*) AS n FROM edit_history WHERE unicode = ?').get(unicode) as { n: number }
    const issue = db.prepare('SELECT reason FROM issues WHERE char = ?').get(String(row.char)) as { reason: string } | undefined
    return {
      ...row,
      issue_reason: issue?.reason ?? null,
      variant_reading: JSON.parse(String(row.variant_reading)) as string[],
      variant_meaning: JSON.parse(String(row.variant_meaning)) as string[],
      radical: meta?.radical ?? 0,
      font_outline: meta ? JSON.parse(meta.font_outline) as string[] : [],
      origin: meta?.origin ?? null,
      origin_url: meta?.origin_url ?? null,
      strokes,
      history_count: history.n,
    }
  }

  function readStrokeRow(unicode: string) {
    return db.prepare(`
      SELECT s.radical, s.font_outline, s.stroke_outlines, s.median_line, s.origin, s.origin_url
      FROM strokes s JOIN characters c ON c.char = s.char WHERE c.unicode = ?
    `).get(unicode) as {
      radical: number
      font_outline: string
      stroke_outlines: string
      median_line: string
      origin: string
      origin_url: string | null
    } | undefined
  }

  function readStrokes(unicode: string): StrokeItem[] {
    const row = readStrokeRow(unicode)
    if (!row) return []
    const outlines = JSON.parse(row.stroke_outlines) as StrokeOutline[]
    const lines = new Map((JSON.parse(row.median_line) as MedianLine[]).map((line) => [line.order, line]))
    return outlines.map((outline) => {
      const line = lines.get(outline.order)
      if (!line) throw new Error(`${outline.order}획의 중심선 데이터가 없습니다.`)
      return {
        outline_path: outline.path,
        median_points: line.points,
        stroke_width: line.width,
        is_radical: outline.radical ? 1 : 0,
        start_cap_type: line.start_cap,
        end_cap_type: line.end_cap,
      }
    })
  }

  function writeStrokes(unicode: string, items: StrokeItem[], by: string, origin?: { source: string; url: string | null }, fontOutline?: string[]) {
    const character = db.prepare('SELECT char FROM characters WHERE unicode = ?').get(unicode) as { char: string } | undefined
    if (!character) throw new Error('등록되지 않은 글자입니다.')
    if (items.length === 0) {
      db.prepare('DELETE FROM strokes WHERE char = ?').run(character.char)
      return
    }
    const outlines: StrokeOutline[] = items.map((item, index) => ({ order: index + 1, path: item.outline_path, radical: item.is_radical ? 1 : 0 }))
    const lines: MedianLine[] = items.map((item, index) => ({
      order: index + 1,
      points: item.median_points,
      width: item.stroke_width,
      start_cap: item.start_cap_type,
      end_cap: item.end_cap_type,
    }))
    db.prepare(`
      INSERT INTO strokes (char, radical, font_outline, stroke_outlines, median_line, last_modified_at, last_modified_by, origin, origin_url)
      VALUES (?, 0, ?, ?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
      ON CONFLICT(char) DO UPDATE SET
        font_outline = CASE WHEN ? THEN excluded.font_outline ELSE strokes.font_outline END,
        stroke_outlines = excluded.stroke_outlines,
        median_line = excluded.median_line,
        last_modified_at = CURRENT_TIMESTAMP,
        last_modified_by = excluded.last_modified_by,
        origin = CASE WHEN ? THEN excluded.origin ELSE strokes.origin END,
        origin_url = CASE WHEN ? THEN excluded.origin_url ELSE strokes.origin_url END
    `).run(
      character.char,
      JSON.stringify(fontOutline ?? items.map((item) => item.outline_path)),
      JSON.stringify(outlines),
      JSON.stringify(lines),
      by,
      origin?.source ?? ORIGIN_MANUAL,
      origin?.url ?? null,
      fontOutline ? 1 : 0,
      origin ? 1 : 0,
      origin ? 1 : 0,
    )
  }

  function updateStrokes(unicode: string, strokes: StrokeItem[], action: string) {
    const current = getCharacter(unicode)
    if (!current) throw new Error('등록되지 않은 글자입니다.')
    remember(unicode, current, action)
    db.exec('BEGIN')
    try {
      writeStrokes(unicode, strokes.map((stroke, index) => {
        if (!Array.isArray(stroke.median_points) || stroke.median_points.length < 2) {
          throw new Error(`${index + 1}획의 중심선이 없습니다.`)
        }
        return {
          outline_path: stroke.outline_path,
          median_points: roundPoints(stroke.median_points),
          stroke_width: clampWidth(stroke.stroke_width),
          is_radical: stroke.is_radical ? 1 : 0,
          start_cap_type: cap(stroke.start_cap_type),
          end_cap_type: cap(stroke.end_cap_type),
        }
      }), ACTOR_USER)
      db.prepare(`
        UPDATE characters SET stroke_count = ?, status = CASE WHEN status = 'DONE' THEN 'AUTO_MATCHED' ELSE status END, last_modified_by = ?
        WHERE unicode = ?
      `).run(strokes.length, ACTOR_USER, unicode)
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
    const snapshot = JSON.parse(row.snapshot_json) as { strokes: (Omit<StrokeItem, 'median_points'> & { median_points: Pt[] | string })[] }
    const items = snapshot.strokes.map((stroke): StrokeItem => ({
      outline_path: stroke.outline_path,
      median_points: typeof stroke.median_points === 'string' ? JSON.parse(stroke.median_points) as Pt[] : stroke.median_points,
      stroke_width: stroke.stroke_width,
      is_radical: stroke.is_radical,
      start_cap_type: stroke.start_cap_type,
      end_cap_type: stroke.end_cap_type,
    }))
    db.exec('BEGIN')
    try {
      writeStrokes(unicode, items, ACTOR_USER)
      db.prepare('UPDATE characters SET stroke_count = ?, last_modified_by = ? WHERE unicode = ?')
        .run(items.length, ACTOR_USER, unicode)
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
    const existing = readStrokes(unicode)
    if (existing.length > 0) {
      const hanja = await loadSource(unicode, 'MMH', hanjaUrl(character.char), () => fetchHanja(character.char))
      const editedBy = (db.prepare('SELECT last_modified_by AS by FROM strokes WHERE char = ?').get(character.char) as { by: string }).by
      // 사용자가 고쳤거나 궁서체 윤곽으로 바꾼 획은 Hanja 중심선으로 덮어쓰지 않는다.
      if (hanja && hanja.value.medians.length === existing.length && editedBy !== ACTOR_USER && editedBy !== ACTOR_FONT) {
        const radical = new Set(hanja.value.radical)
        writeStrokes(unicode, existing.map((stroke, index) => ({
          ...stroke,
          median_points: roundPoints(medianOrRecovered(hanja.value.medians[index], stroke.outline_path) ?? stroke.median_points),
          is_radical: radical.has(index) ? 1 : 0,
        })), ACTOR_HANJA, { source: 'MMH', url: hanja.url })
      }
      return { unicode, source: hanja ? 'MMH' : 'DB', fetched: false }
    }

    const hanja = await loadSource(unicode, 'MMH', hanjaUrl(character.char), () => fetchHanja(character.char))
    const imported = hanja ? hanjaStrokes(hanja.value) : null
    if (hanja && imported) {
      saveImported(unicode, 'MMH', hanja.url, hanja.value.radical, fontOrGiven(character.char, imported.medians, imported.outlines))
      return { unicode, source: 'MMH', fetched: true }
    }
    const composed = await composeIds(character.char)
    if (!composed) {
      setIssue(unicode, 'Hanja, IDS 합성 모두 실패', ACTOR_IDS)
      return { unicode, source: 'NONE', fetched: false }
    }
    const [origin, originUrl] = IDS_ORIGINS[composed.source]
    saveImported(unicode, origin, originUrl, [], fontOrGiven(character.char, composed.medians, []))
    db.prepare(`UPDATE characters SET status = 'AI_ASSISTED', last_modified_by = ? WHERE unicode = ?`).run(ACTOR_IDS, unicode)
    return { unicode, source: composed.source, fetched: true }
  }

  async function syncMissing(limit = MISSING_FETCH_LIMIT) {
    const rows = db.prepare(`
      SELECT c.unicode FROM characters c
      WHERE NOT EXISTS (SELECT 1 FROM strokes s WHERE s.char = c.char)
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
      setIssue(unicode, problems.join(' '), ACTOR_USER)
      throw new Error(problems.join(' '))
    }
    const radical = radicalOf(detail.radical, strokes)
    const compiled = {
      schemaVersion: 1 as const,
      character: detail.char,
      unicode,
      reading: detail.reading ?? '',
      strokeCount: strokes.length,
      coordinateSystem: { size: CANVAS, yAxis: 'up' as const },
      radical,
      fullOutline: detail.font_outline.join(' '),
      strokes: strokes.map((stroke) => stroke.outline_path),
      medians: strokes.map((stroke) => stroke.median_points),
      strokeWidths: strokes.map((stroke) => stroke.stroke_width),
      source: { outline: String(detail.origin_url || detail.origin), medians: String(detail.origin_url || detail.origin) },
    }
    db.prepare(`UPDATE characters SET status = 'AUTO_MATCHED', last_modified_by = ? WHERE unicode = ?`).run(ACTOR_USER, unicode)
    clearIssue(unicode)
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
    db.prepare('UPDATE characters SET status = ?, last_modified_by = ? WHERE unicode = ?').run(status, ACTOR_USER, unicode)
    clearIssue(unicode)
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
        INSERT INTO characters (unicode, char, reading, status, stroke_count, last_modified_by)
        VALUES (?, ?, ?, 'TODO', 0, ?)
      `)
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue
        const char = String((entry as { 한자?: unknown }).한자 ?? '').trim()
        if ([...char].length !== 1 || seen.has(char)) continue
        seen.add(char)
        insertChar.run(unicodeOf(char), char, String((entry as { 음?: unknown }).음 ?? ''), ACTOR_USER)
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

  return { listCharacters, getCharacter, updateStrokes, undo, ensureReference, syncMissing, applyFontBatch, compile, listRadicals, setStatus, importInitial }

  async function loadSource<T>(unicode: string, source: 'MMH', url: string, fetchFresh: () => Promise<Remote<T>>): Promise<Remote<T> | null> {
    const cached = db.prepare('SELECT found, raw_data, source_url FROM reference_data WHERE unicode = ? AND source = ?')
      .get(unicode, source) as { found: number; raw_data: string | null; source_url: string | null } | undefined
    if (cached) {
      if (!cached.source_url) db.prepare('UPDATE reference_data SET source_url = ? WHERE unicode = ? AND source = ?').run(url, unicode, source)
      if (!cached.found || !cached.raw_data) return null
      const value = parseHanja(cached.raw_data) as T | null
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
        HANJA_VERSION,
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

  // TTF는 처음 필요할 때 한 번만 읽는다. project_meta에 기록된 해시와 다르면 작업을 멈춘다.
  function getFont(): FontFile | null {
    if (font !== undefined) return font
    const loaded = loadFont(path.join(rootDir, FONT_FILE))
    if (loaded) {
      const meta = db.prepare('SELECT ttf_sha256 FROM project_meta WHERE id = 1').get() as { ttf_sha256: string }
      if (meta.ttf_sha256 === NO_FONT_SHA256) {
        db.prepare('UPDATE project_meta SET ttf_filename = ?, ttf_sha256 = ?, ttf_units_per_em = ? WHERE id = 1')
          .run(path.basename(FONT_FILE), loaded.sha256, loaded.unitsPerEm)
      } else if (meta.ttf_sha256 !== loaded.sha256) {
        throw new Error('TTF 파일이 project_meta에 기록된 폰트와 다릅니다. 폰트를 되돌리거나 기록을 갱신하세요.')
      }
    }
    font = loaded
    return font
  }

  // 궁서체 윤곽이 있으면 그 윤곽을 중심선으로 나눈다. TTF에 글자가 없거나 분리가 어긋나면 받은 윤곽을 그대로 쓴다(없으면 띠 모양).
  function fontOrGiven(char: string, medians: Pt[][], outlines: string[]): ImportedStrokes {
    const contours = getFont()?.contours(char)
    return (contours && splitByContours(contours, medians)) || { medians, outlines }
  }

  type FontResult = 'APPLIED' | 'EDITED' | 'ALREADY' | 'NO_STROKES' | 'NO_GLYPH' | 'REJECTED'

  // 이미 있는 획의 윤곽을 궁서체 윤곽으로 바꾼다. 기존 중심선을 길잡이로 쓰고, 중심선은 새 윤곽에서 다시 계산한다.
  function applyFont(unicode: string): FontResult {
    const row = db.prepare(`
      SELECT c.char, s.last_modified_by AS by FROM characters c JOIN strokes s ON s.char = c.char WHERE c.unicode = ?
    `).get(unicode) as { char: string; by: string } | undefined
    if (!row) return 'NO_STROKES'
    if (row.by === ACTOR_USER) return 'EDITED'
    if (row.by === ACTOR_FONT) return 'ALREADY'
    const contours = getFont()?.contours(row.char)
    if (!contours) return 'NO_GLYPH'
    const current = getCharacter(unicode)
    if (!current) return 'NO_STROKES'
    const split = splitByContours(contours, current.strokes.map((stroke) => stroke.median_points))
    if (!split?.widths) return 'REJECTED'
    const widths = split.widths
    remember(unicode, current, '궁서체 윤곽으로 교체')
    db.exec('BEGIN')
    try {
      writeStrokes(unicode, current.strokes.map((stroke, index) => ({
        outline_path: split.outlines[index],
        median_points: roundPoints(split.medians[index]),
        stroke_width: widths[index],
        is_radical: stroke.is_radical,
        start_cap_type: stroke.start_cap_type,
        end_cap_type: stroke.end_cap_type,
      })), ACTOR_FONT, undefined, split.fontOutline)
      db.prepare('UPDATE characters SET last_modified_by = ? WHERE unicode = ?').run(ACTOR_FONT, unicode)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    trimHistory(unicode)
    return 'APPLIED'
  }

  // after 다음 유니코드부터 limit자를 처리한다. next가 null이면 끝.
  function applyFontBatch(after: string, limit = FONT_BATCH_LIMIT) {
    if (!getFont()) throw new Error(`폰트 파일이 없습니다: ${FONT_FILE}`)
    const rows = db.prepare('SELECT unicode, char FROM characters WHERE unicode > ? ORDER BY unicode LIMIT ?').all(after, limit) as { unicode: string; char: string }[]
    const counts: Record<FontResult, number> = { APPLIED: 0, EDITED: 0, ALREADY: 0, NO_STROKES: 0, NO_GLYPH: 0, REJECTED: 0 }
    const rejected: string[] = []
    const noGlyph: string[] = []
    for (const row of rows) {
      const result = applyFont(row.unicode)
      counts[result] += 1
      if (result === 'REJECTED') rejected.push(row.char)
      if (result === 'NO_GLYPH') noGlyph.push(row.char)
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return { processed: rows.length, counts, rejected, noGlyph, next: rows.length === limit ? rows[rows.length - 1].unicode : null }
  }

  function setIssue(unicode: string, reason: string, by: string) {
    db.prepare(`UPDATE characters SET status = 'ISSUE', last_modified_by = ? WHERE unicode = ?`).run(by, unicode)
    db.prepare(`
      INSERT INTO issues (char, reason) SELECT char, ? FROM characters WHERE unicode = ?
      ON CONFLICT(char) DO UPDATE SET reason = excluded.reason, created_at = CURRENT_TIMESTAMP
    `).run(reason, unicode)
  }

  function clearIssue(unicode: string) {
    db.prepare('DELETE FROM issues WHERE char = (SELECT char FROM characters WHERE unicode = ?)').run(unicode)
  }

  function saveImported(unicode: string, source: string, url: string | null, radical: number[], strokes: ImportedStrokes) {
    const { medians, outlines, widths, fontOutline } = strokes
    const radicalSet = new Set(radical)
    const by = source === 'MMH' ? ACTOR_HANJA : ACTOR_IDS
    db.exec('BEGIN')
    try {
      writeStrokes(unicode, medians.map((median, index) => ({
        outline_path: outlines[index] || ribbonPath(median, DEFAULT_STROKE_WIDTH),
        median_points: roundPoints(median),
        stroke_width: widths?.[index] ?? DEFAULT_STROKE_WIDTH,
        is_radical: radicalSet.has(index) ? 1 : 0,
        start_cap_type: 'NONE',
        end_cap_type: 'NONE',
      })), by, { source, url }, fontOutline)
      db.prepare(`UPDATE characters SET stroke_count = ?, status = 'AUTO_MATCHED', last_modified_by = ? WHERE unicode = ?`)
        .run(medians.length, by, unicode)
      clearIssue(unicode)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  async function loadIds(): Promise<Map<string, string[]>> {
    if (idsIndex) return idsIndex
    const file = path.join(rootDir, IDS_FILE)
    if (!fs.existsSync(file)) {
      try {
        const response = await fetchLimited(IDS_URL, IDS_FILE_LIMIT)
        if (!response.ok || !response.text.includes(IDS_HEADER)) return new Map()
        fs.writeFileSync(file, response.text)
      } catch {
        return new Map()
      }
    }
    idsIndex = parseIdsFile(fs.readFileSync(file, 'utf-8'))
    return idsIndex
  }

  // 글자의 획이 DB에 있으면 box에 맞춰 쓰고, 없으면 공개 IDS로 한 단계 더 쪼갠다.
  function mediansOfChar(char: string, box: Box, depth: number): Pt[][] | null {
    const row = db.prepare('SELECT unicode FROM characters WHERE char = ?').get(char) as { unicode: string } | undefined
    const strokes = row ? readStrokes(row.unicode) : []
    if (strokes.length > 0) return fitMedians(strokes.map((stroke) => stroke.median_points), box)
    if (depth >= IDS_MAX_DEPTH) return null
    for (const ids of idsIndex?.get(char) ?? []) {
      const node = parseIds(ids)
      const medians = node && composeNode(node, box, depth + 1)
      if (medians?.length) return medians
    }
    return null
  }

  function composeNode(node: IdsNode, box: Box, depth: number): Pt[][] | null {
    if ('leaf' in node) return mediansOfChar(LEAF_FORMS[node.leaf] ?? node.leaf, box, depth)
    const layout = IDS_LAYOUTS[node.op]
    const [left, bottom, right, top] = box
    const medians: Pt[][] = []
    for (let index = 0; index < layout.length; index++) {
      const [x0, y0, x1, y1] = layout[index]
      const sub: Box = [left + x0 * (right - left), bottom + y0 * (top - bottom), left + x1 * (right - left), bottom + y1 * (top - bottom)]
      const part = composeNode(node.children[index], sub, depth)
      if (!part) return null
      medians.push(...part)
    }
    return medians
  }

  function composeFrom(ids: string): Pt[][] | null {
    const node = parseIds(ids)
    if (!node || 'leaf' in node) return null
    const medians = composeNode(node, WHOLE_BOX, 0)
    return medians?.length ? medians : null
  }

  // 사람이 적은 IDS → 공개 IDS(BabelStone) → Ollama 순서로 시도한다.
  async function composeIds(char: string): Promise<{ ids: string; source: IdsSource; medians: Pt[][] } | null> {
    const known = IDS_BOOK[char]
    const knownMedians = known ? composeFrom(known) : null
    if (known && knownMedians) return { ids: known, source: 'MANUAL', medians: knownMedians }
    for (const ids of (await loadIds()).get(char) ?? []) {
      const medians = composeFrom(ids)
      if (medians) return { ids, source: 'IDS', medians }
    }
    const asked = await askOllama(char)
    const askedMedians = asked ? composeFrom(asked) : null
    return asked && askedMedians ? { ids: asked, source: 'OLLAMA', medians: askedMedians } : null
  }
}

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
    origin TEXT NOT NULL CHECK (origin IN ('MMH', 'IDS', 'OLLAMA_IDS', 'MANUAL', 'NONE')),
    origin_url TEXT
  )
`

function charactersDdl(name: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${name} (
      unicode TEXT PRIMARY KEY,
      char TEXT NOT NULL UNIQUE,
      grade TEXT,
      status TEXT NOT NULL DEFAULT 'TODO',
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

const ISSUES_DDL = `
  CREATE TABLE IF NOT EXISTS issues (
    char TEXT PRIMARY KEY REFERENCES characters(char) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
      INSERT INTO characters_next (unicode, char, grade, status, reading, meaning, variant_reading, variant_meaning,
                                   stroke_count, last_modified_at, last_modified_by)
      SELECT unicode, char, grade, status, reading, meaning, variant_reading, variant_meaning,
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

// origin CHECK에 'IDS'가 없는 옛 테이블이면 새 테이블로 갈아끼운다.
function upgradeStrokeOrigins(db: DatabaseSync) {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'strokes'`).get() as { sql: string } | undefined
  if (!row || row.sql.includes(`'IDS'`)) return
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

function migrate(db: DatabaseSync) {
  upgradeCharactersTable(db)
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
      name_kr TEXT NOT NULL,
      stroke_count INTEGER NOT NULL
    );
    ${charactersDdl('characters')};
    ${ISSUES_DDL};
    ${STROKES_DDL};
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
    WHEN NEW.last_modified_at = OLD.last_modified_at
    BEGIN
      UPDATE characters SET last_modified_at = CURRENT_TIMESTAMP WHERE unicode = NEW.unicode;
    END;
  `)
  const version = db.prepare('PRAGMA user_version').get() as { user_version: number }
  if (!version.user_version) db.exec('PRAGMA user_version = 1')
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
const OLLAMA_MODEL = 'qwen3.5:9b'
const OLLAMA_SEED = 1
const OLLAMA_IDS_SCHEMA = {
  type: 'object',
  properties: { ids: { type: 'string' } },
  required: ['ids'],
}

type Box = [number, number, number, number]
const WHOLE_BOX: Box = [0, 0, 1, 1]
const THIRD = 1 / 3
// 부품 배치 칸: [왼쪽, 아래, 오른쪽, 위] (0~1, 세로는 아래가 0). 감싸는 구조는 바깥 부품이 전체, 안쪽 부품이 가운데 칸을 쓴다.
const IDS_LAYOUTS: Record<string, Box[]> = {
  '⿰': [[0, 0, 0.5, 1], [0.5, 0, 1, 1]],
  '⿱': [[0, 0.5, 1, 1], [0, 0, 1, 0.5]],
  '⿲': [[0, 0, THIRD, 1], [THIRD, 0, 2 * THIRD, 1], [2 * THIRD, 0, 1, 1]],
  '⿳': [[0, 2 * THIRD, 1, 1], [0, THIRD, 1, 2 * THIRD], [0, 0, 1, THIRD]],
  '⿴': [WHOLE_BOX, [0.2, 0.2, 0.8, 0.8]],
  '⿵': [WHOLE_BOX, [0.2, 0, 0.8, 0.75]],
  '⿶': [WHOLE_BOX, [0.2, 0.25, 0.8, 1]],
  '⿷': [WHOLE_BOX, [0.25, 0.2, 1, 0.8]],
  '⿸': [WHOLE_BOX, [0.3, 0, 1, 0.7]],
  '⿹': [WHOLE_BOX, [0, 0, 0.7, 0.7]],
  '⿺': [WHOLE_BOX, [0.3, 0.3, 1, 1]],
  '⿻': [WHOLE_BOX, WHOLE_BOX],
}

type IdsNode = { leaf: string } | { op: string; children: IdsNode[] }
type IdsSource = 'MANUAL' | 'IDS' | 'OLLAMA'
const IDS_ORIGINS: Record<IdsSource, [string, string | null]> = {
  MANUAL: ['MANUAL', null],
  IDS: ['IDS', IDS_URL],
  OLLAMA: ['OLLAMA_IDS', OLLAMA_URL],
}
const IDS_OPERATOR = /[\u2FF0-\u2FFF]/
const IDS_UNSUPPORTED = /[{}\\&;]/

// IDS 문자열을 트리로 바꾼다. 지원하지 않는 연산자·조합 표기가 있거나 문자열이 남으면 null.
function parseIds(ids: string): IdsNode | null {
  if (IDS_UNSUPPORTED.test(ids)) return null
  const tokens = [...ids]
  let index = 0
  const read = (): IdsNode | null => {
    const token = tokens[index++]
    if (token === undefined) return null
    const layout = IDS_LAYOUTS[token]
    if (!layout) return IDS_OPERATOR.test(token) ? null : { leaf: token }
    const children: IdsNode[] = []
    for (let count = 0; count < layout.length; count++) {
      const child = read()
      if (!child) return null
      children.push(child)
    }
    return { op: token, children }
  }
  const node = read()
  return node && index === tokens.length ? node : null
}

// BabelStone IDS.TXT: "U+코드<TAB>글자<TAB>^IDS$(지역)[<TAB>...]". 한국(K) 표기를 먼저 둔다. '*'로 시작하는 동치 표기는 건너뛴다.
function parseIdsFile(text: string): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const [, char, ...entries] = line.split('\t')
    const found = entries.flatMap((entry) => {
      const match = /^\^(.+)\$\((.*)\)$/.exec(entry)
      return match ? [{ ids: match[1], korean: match[2].includes('K') }] : []
    })
    if (char && found.length > 0) index.set(char, found.sort((a, b) => Number(b.korean) - Number(a.korean)).map((item) => item.ids))
  }
  return index
}

type Remote<T> = { url: string; raw: string; value: T | null }
type HanjaGlyph = { medians: Pt[][]; outlines: string[]; radical: number[] }

// Hanja 중심선이 없거나 점이 모자라면 그 획의 윤곽에서 직접 계산한다. 계산도 실패하면 null.
function medianOrRecovered(median: Pt[] | undefined, outline: string | undefined): Pt[] | null {
  if (median && median.length >= MEDIAN_MIN_POINTS) return median
  if (!outline) return null
  const recovered = recoverMedian(outline).median.map((point): Pt => [point.x, point.y])
  return recovered.length >= MEDIAN_MIN_POINTS ? recovered : null
}

function hanjaStrokes(glyph: HanjaGlyph): { medians: Pt[][]; outlines: string[] } | null {
  const count = glyph.outlines.length || glyph.medians.length
  const medians: Pt[][] = []
  const outlines: string[] = []
  for (let index = 0; index < count; index++) {
    const median = medianOrRecovered(glyph.medians[index], glyph.outlines[index])
    if (!median) return null
    medians.push(median)
    outlines.push(glyph.outlines[index] ?? '')
  }
  return { medians, outlines }
}

function hanjaUrl(char: string): string {
  return `${HANJA_CDN}/${encodeURIComponent(char)}.json`
}

async function fetchHanja(char: string): Promise<Remote<HanjaGlyph>> {
  const url = hanjaUrl(char)
  const response = await fetchLimited(url)
  if (response.status === 404) return { url, raw: '', value: null }
  if (!response.ok) throw new Error(`Hanja 응답 ${response.status}`)
  return { url, raw: response.text, value: parseHanja(response.text) }
}

function parseHanja(text: string): HanjaGlyph | null {
  try {
    const data = JSON.parse(text) as { medians?: unknown; strokes?: unknown; outlines?: unknown; radStrokes?: unknown; radical?: unknown }
    const medians = Array.isArray(data.medians) ? data.medians.map(asPoints) : []
    const strokeList = Array.isArray(data.strokes) ? data.strokes : data.outlines
    const outlines = Array.isArray(strokeList) ? strokeList.filter((item): item is string => typeof item === 'string') : []
    const radicalSource = Array.isArray(data.radStrokes) ? data.radStrokes : data.radical
    const radical = Array.isArray(radicalSource) ? radicalSource.map(Number).filter(Number.isInteger) : []
    return medians.length || outlines.length ? { medians, outlines, radical } : null
  } catch {
    return null
  }
}

async function askOllama(char: string): Promise<string | null> {
  try {
    const response = await fetch(OLLAMA_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        think: false,
        format: OLLAMA_IDS_SCHEMA,
        options: { temperature: 0, seed: OLLAMA_SEED },
        prompt: `한자 ${char}를 IDS(표의문자 분해)로 나눠라. ids는 IDS 문자열 하나다.\n예) 林 → {"ids":"⿰木木"}\n예) 昌 → {"ids":"⿱日日"}\n예) 謝 → {"ids":"⿰言射"}`,
      }),
    })
    if (!response.ok) return null
    const data = await response.json() as { response?: string }
    const parsed = JSON.parse(data.response ?? '') as { ids?: unknown }
    return typeof parsed.ids === 'string' ? parsed.ids : null
  } catch {
    return null
  }
}

type ImportedStrokes = { medians: Pt[][]; outlines: string[]; widths?: number[]; fontOutline?: string[] }

const NO_FONT_SHA256 = '0'.repeat(SHA256_HEX_LENGTH)

const toPoints = (line: Pt[]): Point[] => line.map(([x, y]) => ({ x, y }))

function contourArea(d: string): number {
  return flattenContours(d, AREA_FLATNESS).reduce((sum, contour) => {
    let twice = 0
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i]
      const b = contour[(i + 1) % contour.length]
      twice += a.x * b.y - b.x * a.y
    }
    return sum + twice / 2
  }, 0)
}

// 길잡이 중심선의 시작점에 가까운 쪽을 시작으로 맞춘다.
function orientLike(line: Point[], guide: Pt[]): Point[] {
  const [gx, gy] = guide[0]
  const first = Math.hypot(line[0].x - gx, line[0].y - gy)
  const last = Math.hypot(line[line.length - 1].x - gx, line[line.length - 1].y - gy)
  return last < first ? line.slice().reverse() : line
}

// 글자 윤곽(contours)을 길잡이 중심선(guide)으로 획마다 나누고, 획마다 중심선을 새 윤곽에서 다시 구한다.
// 어느 획이든 윤곽을 못 찾았거나(전체 윤곽 그대로), 너무 작거나, 획 면적의 합이 글자 면적의 0.85~1.7배를 벗어나면 null.
function splitByContours(contours: string[], guide: Pt[][]): ImportedStrokes | null {
  const fitted = fitMediansToOutline(guide, contours)
  const split = segmentOutlineByMedians(contours, fitted.map(toPoints))
  if (split.strokes.length !== fitted.length) return null
  const glyphArea = Math.abs(contours.reduce((sum, d) => sum + contourArea(d), 0))
  const whole = new Set(contours)
  const medians: Pt[][] = []
  const widths: number[] = []
  let covered = 0
  for (let index = 0; index < fitted.length; index++) {
    const outline = split.strokes[index]
    if (!outline || whole.has(outline)) return null
    const area = Math.abs(contourArea(outline))
    if (area < glyphArea * MIN_STROKE_AREA_RATIO) return null
    covered += area
    const recovered = recoverMedian(outline).median
    if (recovered.length < MEDIAN_MIN_POINTS) return null
    const line = simplifyPolyline(orientLike(recovered, fitted[index]), MEDIAN_SIMPLIFY_TOLERANCE)
    medians.push(line.map((point): Pt => [round1(point.x), round1(point.y)]))
    widths.push(computeOptimalStrokeWidth(outline, line))
  }
  if (covered < glyphArea * MIN_COVERED_AREA_RATIO || covered > glyphArea * MAX_COVERED_AREA_RATIO) return null
  return { medians, outlines: split.strokes, widths, fontOutline: contours }
}

// 합성한 중심선 묶음의 bbox를 글자 윤곽의 bbox(중심선이 윤곽 안쪽에 있으므로 INSET만큼 줄인 것)에 맞춰 늘이고 옮긴다.
function fitMediansToOutline(medians: Pt[][], contours: string[]): Pt[][] {
  const outline = boundsOf(contours.flatMap(pathPoints))
  const source = boundsOf(medians.flat())
  const scaleX = (outline.maxX - outline.minX - 2 * MEDIAN_BBOX_INSET) / Math.max(1, source.maxX - source.minX)
  const scaleY = (outline.maxY - outline.minY - 2 * MEDIAN_BBOX_INSET) / Math.max(1, source.maxY - source.minY)
  return medians.map((line) => line.map(([x, y]): Pt => [
    round1(outline.minX + MEDIAN_BBOX_INSET + (x - source.minX) * scaleX),
    round1(outline.minY + MEDIAN_BBOX_INSET + (y - source.minY) * scaleY),
  ]))
}

function pathPoints(d: string): Pt[] {
  const numbers = (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
  const points: Pt[] = []
  for (let index = 0; index + 1 < numbers.length; index += 2) points.push([numbers[index], numbers[index + 1]])
  return points
}

function boundsOf(points: Pt[]) {
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

// 부품 글자의 모든 획 중심선을 한 덩어리로 보고 box(0~1 비율)에 맞춘다. 획마다 따로 맞추면 모든 획이 box 전체로 늘어난다.
function fitMedians(medians: Pt[][], box: Box): Pt[][] {
  const { minX, maxX, minY, maxY } = boundsOf(medians.flat())
  const [x0, y0, x1, y1] = box
  return medians.map((median) => median.map(([x, y]): Pt => [
    round1((x0 + ((x - minX) / Math.max(1, maxX - minX)) * (x1 - x0)) * CANVAS),
    round1((y0 + ((y - minY) / Math.max(1, maxY - minY)) * (y1 - y0)) * CANVAS),
  ]))
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

function radicalOf(id: number | null, strokes: { is_radical: number }[]) {
  if (!id) return null
  const radical = KANGXI_RADICALS.find((item) => item.id === id)
  if (!radical) return null
  return {
    id,
    char: radical.radical_char,
    origin: null,
    name: radical.name_kr,
    strokeIndices: strokes.flatMap((stroke, index) => stroke.is_radical ? [index] : []),
  }
}

function remember(unicode: string, current: { strokes: unknown }, action: string) {
  dbInsertHistory(unicode, JSON.stringify({ strokes: current.strokes }), action)
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

async function fetchLimited(url: string, limit = FETCH_LIMIT): Promise<{ status: number; ok: boolean; text: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const text = await response.text()
  if (text.length > limit) throw new Error('응답이 너무 큽니다.')
  return { status: response.status, ok: response.ok, text }
}

