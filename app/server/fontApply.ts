import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { FONT_BATCH_LIMIT } from '../shared/constants.ts'
import type { Pt, StrokeRecord } from '../shared/types.ts'
import { markCharacterEdited } from './characterWrites.ts'
import { transaction } from './db.ts'
import { loadFont, type FontFile } from './font.ts'
import { fitGuideToFont, roundPoints, splitByContours, type ImportedStrokes } from './geometry.ts'
import { charactersAfter } from './lookups.ts'
import { ACTION_FONT, ACTOR_FONT, ACTOR_USER } from './model.ts'
import { NO_FONT_SHA256 } from './schema.ts'
import type { StrokeStore } from './strokeStore.ts'

const FONT_FILE = path.join('app', 'fonts', 'Gungseouche.ttf')

type FontGlyph = {
  char: string
  strokes: Pick<StrokeRecord, 'median_points' | 'is_radical' | 'start_cap_type' | 'end_cap_type'>[]
}

export function createFontApply(
  db: DatabaseSync,
  rootDir: string,
  deps: {
    strokes: StrokeStore
    getCharacter: (unicode: string) => FontGlyph | null
  },
) {
  const { strokes, getCharacter } = deps
  let font: FontFile | null | undefined

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

  // 궁서체에 맞추되, 맞지 않는 획은 버리지 않는다. 글자가 폰트에 없으면 받은 윤곽을 그대로 둔다.
  function fitOrGiven(char: string, medians: Pt[][], outlines: string[]) {
    const contours = getFont()?.contours(char) ?? []
    const fitted = contours.length > 0 ? fitGuideToFont(contours, medians) : null
    if (fitted) {
      return {
        glyph: fitted,
        unmatched: fitted.unmatched,
        status: fitted.unmatched.length > 0 ? 'partial' as const : 'fitted' as const,
      }
    }
    return {
      glyph: { medians, outlines } satisfies ImportedStrokes,
      unmatched: medians.map((_, index) => index + 1),
      status: contours.length > 0 ? 'copied' as const : 'no-font' as const,
    }
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
    transaction(db, () => {
      strokes.writeStrokes(unicode, current.strokes.map((stroke, index) => ({
        outline_path: split.outlines[index],
        median_points: roundPoints(split.medians[index]),
        stroke_width: widths[index],
        is_radical: stroke.is_radical,
        start_cap_type: stroke.start_cap_type,
        end_cap_type: stroke.end_cap_type,
      })), ACTOR_FONT, ACTION_FONT, undefined, split.fontOutline)
      markCharacterEdited(db, unicode, ACTOR_FONT)
    })
    return 'APPLIED'
  }

  // after 다음 유니코드부터 limit자를 처리한다. next가 null이면 끝.
  function applyFontBatch(after: string, limit = FONT_BATCH_LIMIT) {
    if (!getFont()) throw new Error(`폰트 파일이 없습니다: ${FONT_FILE}`)
    const rows = charactersAfter(db, after, limit)
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

  return { getFont, fontOrGiven, fitOrGiven, applyFontBatch }
}