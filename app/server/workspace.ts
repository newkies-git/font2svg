import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ACJK_BATCH_LIMIT,
  ACJK_FILE_LIMIT,
  CANVAS,
  DB_BUSY_TIMEOUT_MS,
  DEFAULT_STROKE_WIDTH,
  FONT_BATCH_LIMIT,
  IDS_FILE_LIMIT,
  IDS_MAX_DEPTH,
  MIN_STROKE_WIDTH,
  MISSING_FETCH_LIMIT,
  STROKE_WIDTH_CAP_RATIO,
  UNICODE_HEX_PAD,
} from '../src/lib/constants.ts'
import type { Pt } from '../src/types.ts'
import { animatedSvg, parseAnimSvg } from './animSvg.ts'
import { loadFont, type FontFile } from './font.ts'
import { fitMedians, ribbonPath, roundPoints, splitByContours, type Box, type ImportedStrokes } from './geometry.ts'
import {
  askOllama,
  IDS_BOOK,
  IDS_FILE,
  IDS_HEADER,
  IDS_LAYOUTS,
  IDS_ORIGINS,
  IDS_URL,
  LEAF_FORMS,
  parseIds,
  parseIdsFile,
  WHOLE_BOX,
  type IdsNode,
  type IdsSource,
} from './ids.ts'
import {
  ACTION_ACJK,
  ACTION_APPROVE,
  ACTION_FONT,
  ACTION_NAVER,
  ACTION_SVG,
  ACTION_UNDO,
  ACTOR_ACJK,
  ACTOR_FONT,
  ACTOR_HANJA,
  ACTOR_IDS,
  ACTOR_NAVER,
  ACTOR_USER,
  ORIGIN_MANUAL,
  type MedianLine,
  type StrokeItem,
  type StrokeOutline,
} from './model.ts'
import { KANGXI_RADICALS } from './radicals.ts'
import {
  ACJK_BLOB,
  ACJK_RAW,
  ACJK_VARIANTS,
  ACJK_VERSION,
  fetchHanja,
  fetchLimited,
  fetchNaver,
  HANJA_VERSION,
  hanjaStrokes,
  hanjaUrl,
  medianOrRecovered,
  NAVER_VERSION,
  naverUrl,
  parseHanja,
  type Found,
  type HanjaGlyph,
  type Remote,
} from './references.ts'
import { migrate, NO_FONT_SHA256, seed, type CharacterRow, type StrokeRow } from './schema.ts'

const FONT_FILE = path.join('app', 'fonts', 'Gungseouche.ttf')
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
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`)
  migrate(db)
  seed(db)
  let font: FontFile | null | undefined
  let idsIndex: Map<string, string[]> | undefined
  let acjkIndex: Map<string, { raw: string; url: string }> | undefined

  function listCharacters(query: string) {
    const q = query.trim()
    const rows = db.prepare(`
      SELECT c.unicode, c.char, c.grade, i.reason AS issue_reason, i.status AS issue_status, i.in_font, COALESCE(s.origin, 'NONE') AS origin,
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
    const row = db.prepare('SELECT * FROM characters WHERE unicode = ?').get(unicode) as CharacterRow | undefined
    if (!row) return null
    // strokes에 없으면(승인 전) 작업 데이터를 보여 준다.
    const meta = readStrokeRow(unicode)
    const working = meta ? undefined : readWorkingRow(unicode)
    const shown = meta ?? working
    const strokes = (shown ? itemsOf(shown) : []).map((stroke, index) => ({ stroke_order: index + 1, ...stroke }))
    const history = db.prepare('SELECT COUNT(*) AS n FROM strokes_history WHERE char = ? AND undoable = 1').get(String(row.char)) as { n: number }
    const issue = db.prepare('SELECT reason, status, in_font FROM issues WHERE char = ?').get(String(row.char)) as
      { reason: string; status: string; in_font: number } | undefined
    return {
      ...row,
      issue_reason: issue?.reason ?? null,
      issue_status: issue?.status ?? null,
      in_font: issue?.in_font ?? 0,
      working: Boolean(working),
      variant_reading: JSON.parse(String(row.variant_reading)) as string[],
      variant_meaning: JSON.parse(String(row.variant_meaning)) as string[],
      radical: meta?.radical ?? 0,
      font_outline: shown ? JSON.parse(shown.font_outline) as string[] : [],
      origin: meta?.origin ?? working?.source ?? null,
      origin_url: meta?.origin_url ?? working?.source_url ?? null,
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

  function readWorkingRow(unicode: string) {
    return db.prepare(`
      SELECT w.source, w.source_url, w.font_outline, w.stroke_outlines, w.median_line
      FROM working_data w JOIN characters c ON c.char = w.char WHERE c.unicode = ?
    `).get(unicode) as { source: string; source_url: string | null; font_outline: string; stroke_outlines: string; median_line: string } | undefined
  }

  function readStrokes(unicode: string): StrokeItem[] {
    const row = readStrokeRow(unicode)
    return row ? itemsOf(row) : []
  }

  function itemsOf(row: { stroke_outlines: string; median_line: string }): StrokeItem[] {
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

  function writeStrokes(unicode: string, items: StrokeItem[], by: string, action: string, origin?: { source: string; url: string | null }, fontOutline?: string[]) {
    const character = db.prepare('SELECT char FROM characters WHERE unicode = ?').get(unicode) as { char: string } | undefined
    if (!character) throw new Error('등록되지 않은 글자입니다.')
    if (items.length === 0) {
      db.prepare('DELETE FROM strokes WHERE char = ?').run(character.char)
      return
    }
    const { outlines, lines } = outlinesAndLines(items)
    // 내용이 실제로 바뀔 때만, 바뀌기 전 행을 이력에 남긴다(같은 내용을 다시 쓰면 남기지 않는다).
    const before = db.prepare('SELECT * FROM strokes WHERE char = ?').get(character.char) as StrokeRow | undefined
    if (before && (
      before.stroke_outlines !== JSON.stringify(outlines) ||
      before.median_line !== JSON.stringify(lines) ||
      (fontOutline && before.font_outline !== JSON.stringify(fontOutline)) ||
      (origin && (before.origin !== origin.source || before.origin_url !== origin.url))
    )) pushHistory(before, action, by, 1)
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

  // 승인 전 작업 데이터. strokes와 같은 모양으로 쓰되 획이 없어도 된다.
  function writeWorking(unicode: string, work: { source: string; url: string | null; fontOutline: string[]; items: StrokeItem[] }, by: string) {
    const { outlines, lines } = outlinesAndLines(work.items)
    db.prepare(`
      INSERT INTO working_data (char, source, source_url, font_outline, stroke_outlines, median_line, last_modified_by)
      SELECT char, ?, ?, ?, ?, ?, ? FROM characters WHERE unicode = ?
      ON CONFLICT(char) DO UPDATE SET
        source = excluded.source,
        source_url = excluded.source_url,
        font_outline = excluded.font_outline,
        stroke_outlines = excluded.stroke_outlines,
        median_line = excluded.median_line,
        last_modified_at = CURRENT_TIMESTAMP,
        last_modified_by = excluded.last_modified_by
    `).run(work.source, work.url, JSON.stringify(work.fontOutline), JSON.stringify(outlines), JSON.stringify(lines), by, unicode)
  }

  function updateStrokes(unicode: string, strokes: StrokeItem[], action: string) {
    const current = getCharacter(unicode)
    if (!current) throw new Error('등록되지 않은 글자입니다.')
    const items = strokes.map((stroke, index) => {
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
    })
    db.exec('BEGIN')
    try {
      if (readStrokeRow(unicode)) {
        writeStrokes(unicode, items, ACTOR_USER, action)
        db.prepare('UPDATE characters SET stroke_count = ?, last_modified_by = ? WHERE unicode = ?').run(items.length, ACTOR_USER, unicode)
      } else {
        // strokes에 없는 글자는 승인 전 작업 데이터를 고친다. 궁서체 윤곽만 있던 글자에 획이 생기면 수작업이다.
        const prev = readWorkingRow(unicode)
        const keep = prev && (prev.source !== 'FONT' || items.length === 0)
        writeWorking(unicode, {
          source: keep ? prev.source : ORIGIN_MANUAL,
          url: keep ? prev.source_url : null,
          fontOutline: prev ? JSON.parse(prev.font_outline) as string[] : [],
          items,
        }, ACTOR_USER)
        db.prepare(`
          INSERT INTO issues (char, reason, status) SELECT char, '수작업 편집', ? FROM characters WHERE unicode = ?
          ON CONFLICT(char) DO UPDATE SET status = excluded.status
        `).run(items.length > 0 ? 'DRAFT' : 'OPEN', unicode)
        db.prepare('UPDATE characters SET last_modified_by = ? WHERE unicode = ?').run(ACTOR_USER, unicode)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return getCharacter(unicode)
  }

  // AnimCJK 형식 SVG를 작업 데이터로 가져온다. 승인 전에는 strokes를 건드리지 않으므로 strokes에 이미 있는 글자는 받지 않는다.
  function importSvg(unicode: string, svg: string) {
    const character = db.prepare('SELECT char FROM characters WHERE unicode = ?').get(unicode) as { char: string } | undefined
    if (!character) throw new Error('등록되지 않은 글자입니다.')
    if (readStrokeRow(unicode)) throw new Error('strokes에 이미 있는 글자는 SVG로 가져올 수 없습니다.')
    const items = toItems(parseAnimSvg(svg, character.char), new Set())
    const problems = validate(character.char, items)
    if (problems.length) throw new Error(problems.join(' '))
    return updateStrokes(unicode, items, ACTION_SVG)
  }

  // 작업 데이터를 확인하고 승인하면 strokes로 옮기고, 옮긴 작업 데이터는 지운다. issues 행은 '승인됨'으로 남긴다.
  function approve(unicode: string) {
    const character = db.prepare('SELECT char FROM characters WHERE unicode = ?').get(unicode) as { char: string } | undefined
    if (!character) throw new Error('등록되지 않은 글자입니다.')
    const working = readWorkingRow(unicode)
    if (!working || readStrokeRow(unicode)) throw new Error('승인할 작업 데이터가 없습니다.')
    const items = itemsOf(working)
    const problems = validate(character.char, items)
    if (problems.length) throw new Error(problems.join(' '))
    const fontOutline = JSON.parse(working.font_outline) as string[]
    db.exec('BEGIN')
    try {
      writeStrokes(unicode, items, ACTOR_USER, ACTION_APPROVE, { source: working.source, url: working.source_url }, fontOutline.length > 0 ? fontOutline : undefined)
      db.prepare('UPDATE characters SET stroke_count = ?, last_modified_by = ? WHERE unicode = ?').run(items.length, ACTOR_USER, unicode)
      db.prepare(`UPDATE issues SET status = 'APPROVED' WHERE char = ?`).run(character.char)
      db.prepare('DELETE FROM working_data WHERE char = ?').run(character.char)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return getCharacter(unicode)
  }

  // 가장 최근의 되돌릴 수 있는 이전 상태로 되돌린다. 이력은 지우지 않는다: 되돌리기 전 상태는 되돌릴 수 없는 이력으로 남기고,
  // 되돌아간 이력은 더 이상 되돌릴 대상이 아니게 표시한다(연속으로 누르면 그 전 상태로 한 단계씩 간다).
  function undo(unicode: string) {
    const character = db.prepare('SELECT char FROM characters WHERE unicode = ?').get(unicode) as { char: string } | undefined
    if (!character) throw new Error('등록되지 않은 글자입니다.')
    const target = db.prepare('SELECT * FROM strokes_history WHERE char = ? AND undoable = 1 ORDER BY id DESC LIMIT 1')
      .get(character.char) as (StrokeRow & { id: number }) | undefined
    const current = db.prepare('SELECT * FROM strokes WHERE char = ?').get(character.char) as StrokeRow | undefined
    if (!target || !current) throw new Error('되돌릴 편집이 없습니다.')
    db.exec('BEGIN')
    try {
      pushHistory(current, ACTION_UNDO, ACTOR_USER, 0)
      db.prepare('UPDATE strokes_history SET undoable = 0 WHERE id = ?').run(target.id)
      db.prepare(`
        UPDATE strokes SET radical = ?, font_outline = ?, stroke_outlines = ?, median_line = ?, origin = ?, origin_url = ?,
                           last_modified_at = CURRENT_TIMESTAMP, last_modified_by = ?
        WHERE char = ?
      `).run(target.radical, target.font_outline, target.stroke_outlines, target.median_line, target.origin, target.origin_url, ACTOR_USER, character.char)
      db.prepare('UPDATE characters SET stroke_count = ?, last_modified_by = ? WHERE unicode = ?')
        .run((JSON.parse(target.stroke_outlines) as unknown[]).length, ACTOR_USER, unicode)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return getCharacter(unicode)
  }

  function pushHistory(row: StrokeRow, action: string, by: string, undoable: 0 | 1) {
    db.prepare(`
      INSERT INTO strokes_history (char, radical, font_outline, stroke_outlines, median_line, origin, origin_url,
                                   state_modified_at, state_modified_by, action_desc, changed_by, undoable)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.char, row.radical, row.font_outline, row.stroke_outlines, row.median_line, row.origin, row.origin_url,
      row.last_modified_at, row.last_modified_by, action, by, undoable)
  }

  async function ensureReference(unicode: string) {
    const character = db.prepare('SELECT unicode, char FROM characters WHERE unicode = ?').get(unicode) as { unicode: string; char: string } | undefined
    if (!character) throw new Error('등록되지 않은 글자입니다.')
    const existing = readStrokes(unicode)
    if (existing.length > 0) {
      const hanja = await loadReference(unicode, character.char)
      const row = db.prepare('SELECT last_modified_by AS by, origin FROM strokes WHERE char = ?').get(character.char) as { by: string; origin: string }
      // 사용자가 고쳤거나 궁서체 윤곽으로 바꾼 획은 레퍼런스 중심선으로 덮어쓰지 않는다. 가져온 출처가 같을 때만 갱신한다.
      if (hanja && hanja.source === row.origin && hanja.value.medians.length === existing.length && row.by !== ACTOR_USER && row.by !== ACTOR_FONT) {
        const radical = new Set(hanja.value.radical)
        writeStrokes(unicode, existing.map((stroke, index) => ({
          ...stroke,
          median_points: roundPoints(medianOrRecovered(hanja.value.medians[index], stroke.outline_path) ?? stroke.median_points),
          is_radical: radical.has(index) ? 1 : 0,
        })), ACTOR_HANJA, '레퍼런스 중심선 갱신', { source: hanja.source, url: hanja.url })
      }
      return { unicode, source: hanja ? hanja.source : 'DB', fetched: false }
    }

    if (db.prepare('SELECT 1 FROM working_data WHERE char = ?').get(character.char)) return { unicode, source: 'WORKING', fetched: false }

    const hanja = await loadReference(unicode, character.char)
    const imported = hanja ? hanjaStrokes(hanja.value) : null
    if (hanja && imported) {
      saveImported(unicode, hanja.source, hanja.url, hanja.value.radical, fontOrGiven(character.char, imported.medians, imported.outlines))
      return { unicode, source: hanja.source, fetched: true }
    }
    // Hanja에 없는 글자는 strokes가 아니라 작업 데이터(working_data)에 쓰고 issues에 올린다. 승인해야 strokes로 간다.
    const composed = await composeIds(character.char)
    const contours = getFont()?.contours(character.char) ?? null
    db.exec('BEGIN')
    try {
      if (composed) {
        // IDS 합성 중심선을 길잡이로 궁서체 윤곽을 획별로 나눈다. 못 나누면 전체 윤곽과 띠 모양 획을 둔다.
        const split = contours && splitByContours(contours, composed.medians)
        const [origin, originUrl] = IDS_ORIGINS[composed.source]
        const strokes = split || { medians: composed.medians, outlines: [] }
        writeWorking(unicode, { source: origin, url: originUrl, fontOutline: strokes.fontOutline ?? contours ?? [], items: toItems(strokes, new Set()) }, ACTOR_IDS)
        setIssue(unicode, `Hanja에 없음: ${origin} 합성 초안`, ACTOR_IDS, 'DRAFT', Boolean(contours))
      } else if (contours) {
        writeWorking(unicode, { source: 'FONT', url: null, fontOutline: contours, items: [] }, ACTOR_FONT)
        setIssue(unicode, 'Hanja에 없고 IDS 합성 실패: 궁서체 윤곽만 추출', ACTOR_FONT, 'OPEN', true)
      } else {
        setIssue(unicode, 'Hanja, 궁서체, IDS 합성 모두 실패', ACTOR_IDS)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return { unicode, source: composed?.source ?? (contours ? 'FONT' : 'NONE'), fetched: Boolean(composed || contours) }
  }

  async function syncMissing(limit = MISSING_FETCH_LIMIT) {
    const rows = db.prepare(`
      SELECT c.unicode FROM characters c
      WHERE NOT EXISTS (SELECT 1 FROM strokes s WHERE s.char = c.char)
        AND NOT EXISTS (SELECT 1 FROM working_data w WHERE w.char = c.char)
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
    if (detail.working) throw new Error('승인 전 작업 데이터는 컴파일할 수 없습니다. 먼저 승인하세요.')
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
    db.prepare('UPDATE characters SET last_modified_by = ? WHERE unicode = ?').run(ACTOR_USER, unicode)
    clearIssue(unicode)
    const file = charFile(compiledDir, String(detail.char))
    fs.writeFileSync(file, `${JSON.stringify(compiled)}\n`)
    fs.writeFileSync(charFile(compiledDir, String(detail.char), 'svg'), animatedSvg(unicode, compiled.strokes, compiled.medians, compiled.strokeWidths))
    return compiled
  }

  function listRadicals() {
    return db.prepare('SELECT id, radical_char, variant_chars, reading, meaning, stroke_count FROM radicals ORDER BY id').all()
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
        INSERT INTO characters (unicode, char, grade, reading, meaning, stroke_count, last_modified_by)
        VALUES (?, ?, ?, ?, ?, 0, ?)
      `)
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object') continue
        const char = String((entry as { 한자?: unknown }).한자 ?? '').trim()
        if ([...char].length !== 1 || seen.has(char)) continue
        seen.add(char)
        const { 구분, 음, 훈 } = entry as { 구분?: unknown; 음?: unknown; 훈?: unknown }
        insertChar.run(unicodeOf(char), char, 구분 ? String(구분) : null, String(음 ?? ''), 훈 ? String(훈) : null, ACTOR_USER)
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

  return { listCharacters, getCharacter, updateStrokes, importSvg, approve, undo, applyNaver, ensureReference, syncMissing, applyFontBatch, applyAcjkBatch, compile, listRadicals, importInitial }

  async function loadSource<T>(unicode: string, source: 'MMH' | 'ACJK' | 'NAVER', url: string, fetchFresh: () => Promise<Remote<T>>): Promise<Found<T> | null> {
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
        source === 'MMH' ? HANJA_VERSION : source === 'ACJK' ? ACJK_VERSION : NAVER_VERSION,
        fresh.url,
        fresh.value ? fresh.raw : null,
        fresh.value ? createHash('sha256').update(fresh.raw).digest('hex') : null,
        fresh.value ? 1 : 0,
      )
      return fresh.value ? { ...fresh, value: fresh.value } : null
    } catch {
      return null
    }
  }

  // 네이버 한자사전(한국 획순)을 먼저 보고, 없으면 AnimCJK, 그다음 Hanja(중국 기준)를 본다.
  async function loadReference(unicode: string, char: string) {
    const naver = await loadSource(unicode, 'NAVER', naverUrl(char), () => fetchNaver(char))
    if (naver) return { source: 'NAVER' as const, ...naver }
    const acjk = await loadSource(unicode, 'ACJK', ACJK_BLOB, () => fetchAcjk(char))
    if (acjk) return { source: 'ACJK' as const, ...acjk }
    const hanja = await loadSource(unicode, 'MMH', hanjaUrl(char), () => fetchHanja(char))
    return hanja ? { source: 'MMH' as const, ...hanja } : null
  }

  // 글자별 원본은 graphics 한 줄에 dictionary의 분해식(acjk)을 붙인 JSON이다. 내려받지 못하면 던진다(없는 글자로 기록하지 않기 위해).
  async function loadAcjk(): Promise<Map<string, { raw: string; url: string }>> {
    if (acjkIndex) return acjkIndex
    const read = async (name: string) => {
      const file = path.join(rootDir, 'database', name)
      if (!fs.existsSync(file)) {
        const response = await fetchLimited(`${ACJK_RAW}/${name}`, ACJK_FILE_LIMIT)
        if (!response.ok) throw new Error(`AnimCJK ${name} 응답 ${response.status}`)
        fs.writeFileSync(file, response.text)
      }
      return fs.readFileSync(file, 'utf-8')
    }
    const lines = (text: string) => text.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { character: string; strokes?: unknown; medians?: unknown; acjk?: string })
    const index = new Map<string, { raw: string; url: string }>()
    for (const variant of ACJK_VARIANTS) {
      const graphics = `graphics${variant}.txt`
      const dictionary = new Map(lines(await read(`dictionary${variant}.txt`)).map((entry) => [entry.character, entry.acjk]))
      for (const entry of lines(await read(graphics))) {
        index.set(entry.character, {
          raw: JSON.stringify({ strokes: entry.strokes, medians: entry.medians, acjk: dictionary.get(entry.character) }),
          url: `${ACJK_BLOB}/${graphics}`,
        })
      }
    }
    acjkIndex = index
    return index
  }

  async function fetchAcjk(char: string): Promise<Remote<HanjaGlyph>> {
    const found = (await loadAcjk()).get(char)
    return { url: found?.url ?? ACJK_BLOB, raw: found?.raw ?? '', value: found ? parseHanja(found.raw) : null }
  }

  // 획순이 틀린 글자를 사람이 지정해 네이버 한자사전 획순으로 바꾼다. 사람이 고친 글자도 바꾸며(실행 취소로 되돌린다),
  // 바뀌기 전 strokes 행은 strokes_history에 남고 같은 글자의 작업 데이터는 지워진다. 네이버에 없으면 아무것도 바꾸지 않는다.
  async function applyNaver(unicode: string) {
    const character = db.prepare('SELECT char FROM characters WHERE unicode = ?').get(unicode) as { char: string } | undefined
    if (!character) throw new Error('등록되지 않은 글자입니다.')
    const naver = await loadSource(unicode, 'NAVER', naverUrl(character.char), () => fetchNaver(character.char))
    const imported = naver ? hanjaStrokes(naver.value) : null
    if (!naver || !imported) throw new Error('네이버 한자사전에서 이 글자의 획순을 찾지 못했습니다.')
    saveImported(unicode, 'NAVER', naver.url, naver.value.radical, fontOrGiven(character.char, imported.medians, imported.outlines), ACTION_NAVER)
    return getCharacter(unicode)
  }

  type AcjkResult = 'REPLACED' | 'EDITED' | 'ALREADY' | 'NOT_IN_ACJK'

  // 이미 있는 글자(strokes 또는 승인 전 작업 데이터)를 AnimCJK 데이터로 바꾼다. 사람이 고친 글자는 건너뛴다.
  // 바뀌기 전 strokes 행은 strokes_history에 남고, 같은 글자의 작업 데이터는 지워진다.
  async function applyAcjk(unicode: string): Promise<AcjkResult> {
    const character = db.prepare('SELECT char FROM characters WHERE unicode = ?').get(unicode) as { char: string } | undefined
    if (!character) throw new Error('등록되지 않은 글자입니다.')
    const acjk = await loadSource(unicode, 'ACJK', ACJK_BLOB, () => fetchAcjk(character.char))
    const imported = acjk ? hanjaStrokes(acjk.value) : null
    if (!acjk || !imported) return 'NOT_IN_ACJK'
    const current = (db.prepare('SELECT origin, last_modified_by AS by FROM strokes WHERE char = ?').get(character.char) ??
      db.prepare('SELECT source AS origin, last_modified_by AS by FROM working_data WHERE char = ?').get(character.char)) as { origin: string; by: string } | undefined
    if (current?.by === ACTOR_USER) return 'EDITED'
    if (current?.origin === 'ACJK') return 'ALREADY'
    saveImported(unicode, 'ACJK', acjk.url, acjk.value.radical, fontOrGiven(character.char, imported.medians, imported.outlines), ACTION_ACJK)
    return 'REPLACED'
  }

  // after 다음 유니코드부터 limit자를 처리한다. next가 null이면 끝.
  async function applyAcjkBatch(after: string, limit = ACJK_BATCH_LIMIT) {
    const rows = db.prepare('SELECT unicode, char FROM characters WHERE unicode > ? ORDER BY unicode LIMIT ?').all(after, limit) as { unicode: string; char: string }[]
    const counts: Record<AcjkResult, number> = { REPLACED: 0, EDITED: 0, ALREADY: 0, NOT_IN_ACJK: 0 }
    const edited: string[] = []
    for (const row of rows) {
      const result = await applyAcjk(row.unicode)
      counts[result] += 1
      if (result === 'EDITED') edited.push(row.char)
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return { processed: rows.length, counts, edited, next: rows.length === limit ? rows[rows.length - 1].unicode : null }
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
    db.exec('BEGIN')
    try {
      writeStrokes(unicode, current.strokes.map((stroke, index) => ({
        outline_path: split.outlines[index],
        median_points: roundPoints(split.medians[index]),
        stroke_width: widths[index],
        is_radical: stroke.is_radical,
        start_cap_type: stroke.start_cap_type,
        end_cap_type: stroke.end_cap_type,
      })), ACTOR_FONT, ACTION_FONT, undefined, split.fontOutline)
      db.prepare('UPDATE characters SET last_modified_by = ? WHERE unicode = ?').run(ACTOR_FONT, unicode)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
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

  function setIssue(unicode: string, reason: string, by: string, status: 'OPEN' | 'DRAFT' = 'OPEN', inFont = false) {
    db.prepare('UPDATE characters SET last_modified_by = ? WHERE unicode = ?').run(by, unicode)
    db.prepare(`
      INSERT INTO issues (char, reason, status, in_font) SELECT char, ?, ?, ? FROM characters WHERE unicode = ?
      ON CONFLICT(char) DO UPDATE SET reason = excluded.reason, status = excluded.status, in_font = excluded.in_font, created_at = CURRENT_TIMESTAMP
    `).run(reason, status, inFont ? 1 : 0, unicode)
  }

  // 승인된 기록('APPROVED')은 남긴다.
  function clearIssue(unicode: string) {
    db.prepare(`DELETE FROM issues WHERE char = (SELECT char FROM characters WHERE unicode = ?) AND status <> 'APPROVED'`).run(unicode)
  }

  function saveImported(unicode: string, source: string, url: string | null, radical: number[], strokes: ImportedStrokes, action = `${source} 가져오기`) {
    const { medians, fontOutline } = strokes
    // 궁서체 윤곽으로 나눠졌으면 궁서체 교체와 같은 상태다(이후 레퍼런스가 중심선을 되덮지 않는다).
    const by = fontOutline ? ACTOR_FONT : source === 'MMH' ? ACTOR_HANJA : source === 'NAVER' ? ACTOR_NAVER : ACTOR_ACJK
    db.exec('BEGIN')
    try {
      writeStrokes(unicode, toItems(strokes, new Set(radical)), by, action, { source, url }, fontOutline)
      db.prepare('DELETE FROM working_data WHERE char = (SELECT char FROM characters WHERE unicode = ?)').run(unicode)
      db.prepare('UPDATE characters SET stroke_count = ?, last_modified_by = ? WHERE unicode = ?')
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
    name: `${radical.meaning} ${radical.reading}`,
    strokeIndices: strokes.flatMap((stroke, index) => stroke.is_radical ? [index] : []),
  }
}

function unicodeOf(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(UNICODE_HEX_PAD, '0')}`
}

function outlinesAndLines(items: StrokeItem[]): { outlines: StrokeOutline[]; lines: MedianLine[] } {
  return {
    outlines: items.map((item, index) => ({ order: index + 1, path: item.outline_path, radical: item.is_radical ? 1 : 0 })),
    lines: items.map((item, index) => ({
      order: index + 1,
      points: item.median_points,
      width: item.stroke_width,
      start_cap: item.start_cap_type,
      end_cap: item.end_cap_type,
    })),
  }
}

// 가져온 중심선·윤곽을 저장용 획으로 바꾼다. 윤곽이 없는 획은 중심선을 따라 띠 모양으로 만든다.
function toItems(strokes: ImportedStrokes, radical: Set<number>): StrokeItem[] {
  return strokes.medians.map((median, index) => ({
    outline_path: strokes.outlines[index] || ribbonPath(median, DEFAULT_STROKE_WIDTH),
    median_points: roundPoints(median),
    stroke_width: strokes.widths?.[index] ?? DEFAULT_STROKE_WIDTH,
    is_radical: radical.has(index) ? 1 : 0,
    start_cap_type: 'NONE',
    end_cap_type: 'NONE',
  }))
}

function clampWidth(value: number): number {
  return Math.max(MIN_STROKE_WIDTH, Math.min(Math.round(DEFAULT_STROKE_WIDTH * STROKE_WIDTH_CAP_RATIO), Math.round(value) || DEFAULT_STROKE_WIDTH))
}

function cap(value: string): string {
  return value === 'AUTO_ROUND' || value === 'REF_STAMP' ? value : 'NONE'
}

function charFile(dir: string, char: string, extension = 'json'): string {
  if ([...char].length !== 1) throw new Error('한자 1자만 저장할 수 있습니다.')
  const file = path.resolve(dir, `${char}.${extension}`)
  if (!file.startsWith(path.resolve(dir) + path.sep)) throw new Error('경로가 올바르지 않습니다.')
  return file
}

