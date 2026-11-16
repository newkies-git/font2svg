import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { migrate, seed } from '../server/schema.ts'
import type { StrokeRecord } from '../shared/types.ts'

export function tempDir(prefix = 'font2svg-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// 마이그레이션까지 마친 임시 DB(파일). 테스트가 끝나면 호출자가 dir을 지운다.
export function openMigratedDb(dir: string): { db: DatabaseSync; file: string } {
  const file = path.join(dir, 'chusa1817.db')
  const db = new DatabaseSync(file)
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db, { backupBasePath: file })
  seed(db)
  return { db, file }
}

export function rectPath(x0: number, y0: number, x1: number, y1: number): string {
  return `M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1} L ${x0} ${y1} Z`
}

export function strokeOf(outline: string, median: [number, number][], overrides: Partial<StrokeRecord> = {}): StrokeRecord {
  return {
    stroke_order: 1,
    outline_path: outline,
    median_points: median,
    stroke_width: 100,
    is_radical: 0,
    start_cap_type: 'NONE',
    end_cap_type: 'NONE',
    ...overrides,
  }
}

// 글자 하나를 넣어 둔다(character_layers가 characters(char)를 참조한다).
export function insertCharacter(db: DatabaseSync, unicode: string, char: string): void {
  db.prepare(`INSERT INTO characters (unicode, char, reading, last_modified_by) VALUES (?, ?, '시험', 'test')`).run(unicode, char)
}
