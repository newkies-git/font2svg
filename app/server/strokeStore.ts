import type { DatabaseSync } from 'node:sqlite'
import { clampStrokeWidth } from '../shared/clamp.ts'
import { DEFAULT_STROKE_WIDTH } from '../shared/constants.ts'
import { parseAnimSvg } from './animSvg.ts'
import { validate } from './compileOutput.ts'
import { transaction } from './db.ts'
import { ribbonPath, roundPoints, type ImportedStrokes } from './geometry.ts'
import {
  ACTION_APPROVE,
  ACTION_SVG,
  ACTION_UNDO,
  ACTOR_USER,
  normalizeCap,
  ORIGIN_MANUAL,
  type MedianLine,
  type StrokeItem,
  type StrokeOutline,
} from './model.ts'
import type { StrokeRow } from './schema.ts'
import { parseMedianLines, parseStringArray, parseStrokeOutlines } from './storedJson.ts'

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
export function toItems(strokes: ImportedStrokes, radical: Set<number>): StrokeItem[] {
  return strokes.medians.map((median, index) => ({
    outline_path: strokes.outlines[index] || ribbonPath(median, DEFAULT_STROKE_WIDTH),
    median_points: roundPoints(median),
    stroke_width: strokes.widths?.[index] ?? DEFAULT_STROKE_WIDTH,
    is_radical: radical.has(index) ? 1 : 0,
    start_cap_type: 'NONE',
    end_cap_type: 'NONE',
  }))
}

export function itemsOf(row: { stroke_outlines: string; median_line: string }): StrokeItem[] {
  const outlines = parseStrokeOutlines(row.stroke_outlines)
  const lines = new Map(parseMedianLines(row.median_line).map((line) => [line.order, line]))
  return outlines.map((outline): StrokeItem => {
    const line = lines.get(outline.order)
    if (!line) throw new Error(`${outline.order}획의 중심선 데이터가 없습니다.`)
    return {
      outline_path: outline.path,
      median_points: line.points,
      stroke_width: line.width,
      is_radical: outline.radical ? 1 : 0,
      start_cap_type: normalizeCap(line.start_cap),
      end_cap_type: normalizeCap(line.end_cap),
    }
  })
}

// 화면에서 받은 획을 저장 형식으로 정리한다. 중심선이 없는 획은 거부하고, 폭·끝 모양·부수 표시는 허용 범위로 맞춘다.
export function sanitizedItems(strokes: StrokeItem[]): StrokeItem[] {
  return strokes.map((stroke, index): StrokeItem => {
    if (!Array.isArray(stroke.median_points) || stroke.median_points.length < 2) {
      throw new Error(`${index + 1}획의 중심선이 없습니다.`)
    }
    return {
      outline_path: stroke.outline_path,
      median_points: roundPoints(stroke.median_points),
      stroke_width: clampStrokeWidth(stroke.stroke_width),
      is_radical: stroke.is_radical ? 1 : 0,
      start_cap_type: normalizeCap(stroke.start_cap_type),
      end_cap_type: normalizeCap(stroke.end_cap_type),
    }
  })
}

export function createStrokeStore(db: DatabaseSync) {
  function requireCharacter(unicode: string): { char: string } {
    const character = db.prepare('SELECT char FROM characters WHERE unicode = ?').get(unicode) as { char: string } | undefined
    if (!character) throw new Error('등록되지 않은 글자입니다.')
    return character
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

  function pushHistory(row: StrokeRow, action: string, by: string, undoable: 0 | 1) {
    db.prepare(`
      INSERT INTO strokes_history (char, radical, font_outline, stroke_outlines, median_line, origin, origin_url,
                                   state_modified_at, state_modified_by, action_desc, changed_by, undoable)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.char, row.radical, row.font_outline, row.stroke_outlines, row.median_line, row.origin, row.origin_url,
      row.last_modified_at, row.last_modified_by, action, by, undoable)
  }

  function writeStrokes(unicode: string, items: StrokeItem[], by: string, action: string, origin?: { source: string; url: string | null }, fontOutline?: string[]) {
    const character = requireCharacter(unicode)
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
    requireCharacter(unicode)
    const items = sanitizedItems(strokes)
    transaction(db, () => {
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
          fontOutline: prev ? parseStringArray(prev.font_outline, '궁서체 윤곽') : [],
          items,
        }, ACTOR_USER)
        db.prepare(`
          INSERT INTO issues (char, reason, status) SELECT char, '수작업 편집', ? FROM characters WHERE unicode = ?
          ON CONFLICT(char) DO UPDATE SET status = excluded.status
        `).run(items.length > 0 ? 'DRAFT' : 'OPEN', unicode)
        db.prepare('UPDATE characters SET last_modified_by = ? WHERE unicode = ?').run(ACTOR_USER, unicode)
      }
    })
  }

  // AnimCJK 형식 SVG를 작업 데이터로 가져온다. 승인 전에는 strokes를 건드리지 않으므로 strokes에 이미 있는 글자는 받지 않는다.
  function importSvg(unicode: string, svg: string) {
    const character = requireCharacter(unicode)
    if (readStrokeRow(unicode)) throw new Error('strokes에 이미 있는 글자는 SVG로 가져올 수 없습니다.')
    const items = toItems(parseAnimSvg(svg, character.char), new Set())
    const problems = validate(character.char, items)
    if (problems.length) throw new Error(problems.join(' '))
    updateStrokes(unicode, items, ACTION_SVG)
  }

  // 작업 데이터를 확인하고 승인하면 strokes로 옮기고, 옮긴 작업 데이터는 지운다. issues 행은 '승인됨'으로 남긴다.
  function approve(unicode: string) {
    const character = requireCharacter(unicode)
    const working = readWorkingRow(unicode)
    if (!working || readStrokeRow(unicode)) throw new Error('승인할 작업 데이터가 없습니다.')
    const items = itemsOf(working)
    const problems = validate(character.char, items)
    if (problems.length) throw new Error(problems.join(' '))
    const fontOutline = parseStringArray(working.font_outline, '궁서체 윤곽')
    transaction(db, () => {
      writeStrokes(unicode, items, ACTOR_USER, ACTION_APPROVE, { source: working.source, url: working.source_url }, fontOutline.length > 0 ? fontOutline : undefined)
      db.prepare('UPDATE characters SET stroke_count = ?, last_modified_by = ? WHERE unicode = ?').run(items.length, ACTOR_USER, unicode)
      db.prepare(`UPDATE issues SET status = 'APPROVED' WHERE char = ?`).run(character.char)
      db.prepare('DELETE FROM working_data WHERE char = ?').run(character.char)
    })
  }

  // 가장 최근의 되돌릴 수 있는 이전 상태로 되돌린다. 이력은 지우지 않는다: 되돌리기 전 상태는 되돌릴 수 없는 이력으로 남기고,
  // 되돌아간 이력은 더 이상 되돌릴 대상이 아니게 표시한다(연속으로 누르면 그 전 상태로 한 단계씩 간다).
  function undo(unicode: string) {
    const character = requireCharacter(unicode)
    const target = db.prepare('SELECT * FROM strokes_history WHERE char = ? AND undoable = 1 ORDER BY id DESC LIMIT 1')
      .get(character.char) as (StrokeRow & { id: number }) | undefined
    const current = db.prepare('SELECT * FROM strokes WHERE char = ?').get(character.char) as StrokeRow | undefined
    if (!target || !current) throw new Error('되돌릴 편집이 없습니다.')
    transaction(db, () => {
      pushHistory(current, ACTION_UNDO, ACTOR_USER, 0)
      db.prepare('UPDATE strokes_history SET undoable = 0 WHERE id = ?').run(target.id)
      db.prepare(`
        UPDATE strokes SET radical = ?, font_outline = ?, stroke_outlines = ?, median_line = ?, origin = ?, origin_url = ?,
                           last_modified_at = CURRENT_TIMESTAMP, last_modified_by = ?
        WHERE char = ?
      `).run(target.radical, target.font_outline, target.stroke_outlines, target.median_line, target.origin, target.origin_url, ACTOR_USER, character.char)
      db.prepare('UPDATE characters SET stroke_count = ?, last_modified_by = ? WHERE unicode = ?')
        .run(parseStrokeOutlines(target.stroke_outlines).length, ACTOR_USER, unicode)
    })
  }

  return {
    requireCharacter,
    readStrokeRow,
    readWorkingRow,
    readStrokes,
    itemsOf,
    writeStrokes,
    writeWorking,
    updateStrokes,
    importSvg,
    approve,
    undo,
  }
}

export type StrokeStore = ReturnType<typeof createStrokeStore>
