import type { DatabaseSync } from 'node:sqlite'
import { CANVAS, DEFAULT_STROKE_WIDTH } from '../../shared/constants.ts'
import { KANGXI_RADICALS } from '../radicals.ts'
import { NO_FONT_SHA256 } from './ddl.ts'

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
