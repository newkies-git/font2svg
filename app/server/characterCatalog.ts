import type { DatabaseSync } from 'node:sqlite'
import { UNICODE_HEX_PAD } from '../shared/constants.ts'
import type { StrokeRecord } from '../shared/types.ts'
import { transaction } from './db.ts'
import { buildCharacterLayers } from './layers.ts'
import { ACTOR_USER } from './model.ts'
import type { CharacterRow } from './schema.ts'
import { type StrokeStore } from './strokeStore.ts'

function unicodeOf(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(UNICODE_HEX_PAD, '0')}`
}

export function createCharacterCatalog(
  db: DatabaseSync,
  deps: {
    strokes: StrokeStore
    fontContours: (char: string) => string[] | null
  },
) {
  const { strokes, fontContours } = deps

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
    const meta = strokes.readStrokeRow(unicode)
    const working = meta ? undefined : strokes.readWorkingRow(unicode)
    const shown = meta ?? working
    const strokeItems = shown ? strokes.itemsOf(shown) : []
    const strokeRecords: StrokeRecord[] = strokeItems.map((stroke, index) => ({ stroke_order: index + 1, ...stroke }))
    const history = db.prepare('SELECT COUNT(*) AS n FROM strokes_history WHERE char = ? AND undoable = 1').get(String(row.char)) as { n: number }
    const issue = db.prepare('SELECT reason, status, in_font FROM issues WHERE char = ?').get(String(row.char)) as
      { reason: string; status: string; in_font: number } | undefined
    const fontOutline = shown ? JSON.parse(shown.font_outline) as string[] : []
    const originUrl = meta?.origin_url ?? working?.source_url ?? null
    const contours = fontContours(String(row.char)) ?? fontOutline
    const layers = buildCharacterLayers(db, {
      unicode,
      char: String(row.char),
      working: Boolean(working),
      historyCount: history.n,
      originUrl,
      strokes: strokeRecords,
      fontContours: contours,
    })
    return {
      ...row,
      issue_reason: issue?.reason ?? null,
      issue_status: issue?.status ?? null,
      in_font: issue?.in_font ?? 0,
      working: Boolean(working),
      variant_reading: JSON.parse(String(row.variant_reading)) as string[],
      variant_meaning: JSON.parse(String(row.variant_meaning)) as string[],
      radical: meta?.radical ?? 0,
      font_outline: fontOutline,
      origin: meta?.origin ?? working?.source ?? null,
      origin_url: originUrl,
      strokes: strokeRecords,
      layers,
      history_count: history.n,
    }
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
    transaction(db, () => {
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
    })
    return { imported }
  }

  return { listCharacters, getCharacter, listRadicals, importInitial }
}
