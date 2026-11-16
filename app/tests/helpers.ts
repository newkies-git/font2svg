import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import opentype from 'opentype.js'
import { migrate, seed } from '../server/schema.ts'
import { flattenContours, polygonArea } from '../shared/paths.ts'
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

export type TestGlyph = { char: string; draw: (path: opentype.Path) => void }

// 글리프 몇 개만 가진 작은 TTF를 만들어 file에 쓴다(실제 궁서체는 라이선스 때문에 저장소에 없다). 글꼴 단위는 1000이다.
export function writeTestFont(file: string, glyphs: TestGlyph[]): void {
  const notdef = new opentype.Glyph({ name: '.notdef', unicode: 0, advanceWidth: 1000, path: new opentype.Path() })
  const font = new opentype.Font({
    familyName: 'TestFont',
    styleName: 'Regular',
    unitsPerEm: 1000,
    ascender: 800,
    descender: -200,
    glyphs: [notdef, ...glyphs.map(({ char, draw }) => {
      const path = new opentype.Path()
      draw(path)
      return new opentype.Glyph({ name: `g${char.codePointAt(0)}`, unicode: char.codePointAt(0)!, advanceWidth: 1000, path })
    })],
  })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, Buffer.from(font.toArrayBuffer()))
}

// 글꼴 좌표(y 위쪽)의 직사각형 윤곽 하나
export function drawRect(target: opentype.Path, x0: number, y0: number, x1: number, y1: number): void {
  target.moveTo(x0, y0)
  target.lineTo(x1, y0)
  target.lineTo(x1, y1)
  target.lineTo(x0, y1)
  target.close()
}

// 테스트가 윤곽 경로를 점검할 때 쓰는 기하 도우미. 곡선은 같은 허용 오차로 편다.
const TEST_FLATNESS = 1.4

export function pathBounds(path: string): { minX: number; maxX: number; minY: number; maxY: number } {
  const points = flattenContours(path, TEST_FLATNESS).flat()
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

// 구멍(반대로 감긴 윤곽)을 뺀 면적
export function pathArea(path: string): number {
  return Math.abs(flattenContours(path, TEST_FLATNESS).reduce((sum, contour) => sum + polygonArea(contour), 0))
}

// 윤곽(구멍 포함, 비영 감기수 규칙)이 점을 덮는지
export function pathCovers(path: string, point: { x: number; y: number }): boolean {
  let winding = 0
  for (const contour of flattenContours(path, TEST_FLATNESS)) {
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i]
      const b = contour[(i + 1) % contour.length]
      if ((a.y <= point.y) !== (b.y <= point.y)) {
        const t = (point.y - a.y) / (b.y - a.y)
        if (a.x + t * (b.x - a.x) > point.x) winding += b.y > a.y ? 1 : -1
      }
    }
  }
  return winding !== 0
}
