import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { createFontApply } from '../server/fontApply.ts'
import { ACTOR_USER } from '../server/model.ts'
import { createStrokeStore } from '../server/strokeStore.ts'
import { drawRect, insertCharacter, openMigratedDb, rectPath, tempDir, writeTestFont } from './helpers.ts'

const dirs: string[] = []
after(() => dirs.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })))

// 프로젝트 폴더 하나: DB, 폰트(app/fonts/Gungseouche.ttf), 글자 목록을 갖춘 작업 공간 조각.
function project(options: { font: boolean }) {
  const root = tempDir()
  dirs.push(root)
  const { db } = openMigratedDb(root)
  if (options.font) {
    writeTestFont(path.join(root, 'app', 'fonts', 'Gungseouche.ttf'), [{ char: '一', draw: (p) => drawRect(p, 100, 300, 900, 400) }])
  }
  const strokes = createStrokeStore(db)
  const apply = createFontApply(db, root, {
    strokes,
    getCharacter: (unicode) => {
      const row = db.prepare('SELECT char FROM characters WHERE unicode = ?').get(unicode) as { char: string } | undefined
      return row ? { char: row.char, strokes: strokes.readStrokes(unicode).map((stroke) => ({ ...stroke })) } : null
    },
  })
  // 글자와, 마지막 수정자가 by인 획 하나(글꼴 윤곽 위를 지나는 가로 중심선)를 넣는다.
  function seed(unicode: string, char: string, by: string) {
    insertCharacter(db, unicode, char)
    strokes.writeStrokes(unicode, [{ outline_path: rectPath(100, 400, 900, 520), median_points: [[150, 460], [870, 460]], stroke_width: 110, is_radical: 0, start_cap_type: 'NONE', end_cap_type: 'NONE' }], by, '시험')
  }
  return { root, db, apply, seed }
}

test('폰트 파일이 없으면 일괄 적용을 거부한다', () => {
  const { apply } = project({ font: false })
  assert.equal(apply.getFont(), null)
  assert.throws(() => apply.applyFontBatch(''), /폰트 파일이 없습니다/)
})

test('첫 로드에 폰트 해시를 project_meta에 기록하고, 다른 폰트면 멈춘다', () => {
  const { root, db, apply } = project({ font: true })
  const font = apply.getFont()!
  const meta = db.prepare('SELECT ttf_sha256, ttf_units_per_em FROM project_meta WHERE id = 1').get() as { ttf_sha256: string; ttf_units_per_em: number }
  assert.equal(meta.ttf_sha256, font.sha256)
  assert.equal(meta.ttf_units_per_em, 1000)
  // 같은 DB에 다른 폰트를 물리면 거부한다.
  writeTestFont(path.join(root, 'app', 'fonts', 'Gungseouche.ttf'), [{ char: '一', draw: (p) => drawRect(p, 0, 0, 500, 500) }])
  const other = createFontApply(db, root, { strokes: createStrokeStore(db), getCharacter: () => null })
  assert.throws(() => other.getFont(), /project_meta에 기록된 폰트와 다릅니다/)
})

test('일괄 적용: 결과를 종류별로 세고 두 번째는 이미 적용으로 센다', () => {
  const { db, apply, seed } = project({ font: true })
  seed('U+4E00', '一', 'system:hanja') // 글리프 있음 → APPLIED
  seed('U+4E8C', '二', 'system:hanja') // 폰트에 글리프 없음 → NO_GLYPH
  seed('U+4E09', '三', ACTOR_USER) // 사람이 고침 → EDITED
  insertCharacter(db, 'U+56DB', '四') // 획 없음 → NO_STROKES
  const first = apply.applyFontBatch('')
  assert.equal(first.processed, 4)
  assert.deepEqual({ ...first.counts }, { APPLIED: 1, EDITED: 1, ALREADY: 0, NO_STROKES: 1, NO_GLYPH: 1, REJECTED: 0 })
  assert.deepEqual(first.noGlyph, ['二'])
  assert.equal(first.next, null)
  const row = db.prepare(`SELECT last_modified_by AS by FROM strokes WHERE char = '一'`).get() as { by: string }
  assert.equal(row.by, 'system:font')
  const second = apply.applyFontBatch('')
  assert.equal(second.counts.APPLIED, 0)
  assert.equal(second.counts.ALREADY, 1)
})

test('일괄 적용: limit만큼 처리하고 다음 위치를 돌려준다', () => {
  const { apply, seed } = project({ font: true })
  seed('U+4E00', '一', 'system:hanja')
  seed('U+4E8C', '二', 'system:hanja')
  const page = apply.applyFontBatch('', 1)
  assert.equal(page.processed, 1)
  assert.equal(page.next, 'U+4E00')
  assert.equal(apply.applyFontBatch(page.next!, 1).processed, 1)
})
