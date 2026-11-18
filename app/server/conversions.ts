import type { DatabaseSync } from 'node:sqlite'
import { setCharacterStrokeCount } from './characterWrites.ts'
import { animatedSvg } from './animSvg.ts'
import { transaction } from './db.ts'
import { splitByContours, strokesFromComponents, type ImportedStrokes } from './geometry.ts'
import type { createIssues } from './issues.ts'
import { parseImageImport, type ImageImportRequest } from './imageRequests.ts'
import { ACTION_IMAGE, ACTOR_USER, CONVERSION_IMAGE_TO_SVG, ORIGIN_MANUAL } from './model.ts'
import type { ConversionRow } from './schema.ts'
import { toItems, type StrokeStore } from './strokeStore.ts'

export type ConversionMode = 'GUIDED' | 'COMPONENTS'
export type ConversionDestination = 'STROKES' | 'WORKING'

const ISSUE_REASON_IMAGE = '이미지 변환 초안'

// 외부 입력을 획 SVG로 바꾸는 일과 그 이력(conversions). 현재는 래스터 이미지에서 뽑은 윤곽만 받는다.
export function createConversions(db: DatabaseSync, deps: { strokes: StrokeStore; issues: ReturnType<typeof createIssues> }) {
  const { strokes, issues } = deps

  function recordConversion(char: string, request: ImageImportRequest, result: { mode: ConversionMode; destination: ConversionDestination; strokeCount: number; svg: string }) {
    const { image } = request
    db.prepare(`
      INSERT INTO conversions (char, kind, source_name, source_mime, source_sha256, source_width, source_height,
                               threshold, invert, mode, destination, stroke_count, result_svg, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(char, CONVERSION_IMAGE_TO_SVG, image.name, image.mime, image.sha256, image.width, image.height,
      image.threshold, image.invert ? 1 : 0, result.mode, result.destination, result.strokeCount, result.svg, ACTOR_USER)
  }

  // 이미지에서 뽑은 윤곽을 획으로 나눠 저장하고 변환 이력을 남긴다. 전부 한 트랜잭션이다.
  //  - 길잡이 중심선(이미 있는 획 또는 승인 전 작업 데이터, 2획 이상)이 있으면 그 중심선으로 윤곽을 획별로 나눈다(GUIDED).
  //  - 없거나 COMPONENTS를 고르면 이어진 덩어리 하나를 획 하나로 본다(COMPONENTS). 결과는 초안이므로 화면에서 칼 분할·중심선 편집으로 고친다.
  //  - strokes가 있는 글자는 교체하고(바뀌기 전 행은 strokes_history에 남아 실행 취소할 수 있다), 없는 글자는 승인 전 작업 데이터로 둔다.
  function importImage(unicode: string, raw: unknown): { mode: ConversionMode; destination: ConversionDestination; strokeCount: number } {
    const request = parseImageImport(raw)
    const { char } = strokes.requireCharacter(unicode)
    const existing = strokes.readStrokes(unicode)
    const working = existing.length === 0 ? strokes.readWorkingRow(unicode) : undefined
    const guide = existing.length > 0 ? existing : working ? strokes.itemsOf(working) : []

    // 중심선이 한 획뿐이면 윤곽 전체가 그 획이라 나눌 것이 없다(나눔 검사도 전체 윤곽 그대로를 거부한다). 2획 이상일 때만 길잡이로 쓴다.
    const mode: ConversionMode = request.split === 'AUTO' && guide.length > 1 ? 'GUIDED' : 'COMPONENTS'
    const glyph: ImportedStrokes | null = mode === 'GUIDED'
      ? splitByContours(request.contours, guide.map((stroke) => stroke.median_points))
      : strokesFromComponents(request.contours)
    if (!glyph) {
      throw new Error(mode === 'GUIDED'
        ? '이미지 윤곽이 기존 중심선으로 나뉘지 않았습니다(품질 검사 실패). 글자 위치·크기가 맞는 이미지인지 확인하거나, 덩어리를 획으로 보는 방식으로 다시 시도하세요.'
        : '이미지 윤곽에서 획의 중심선을 구하지 못했습니다.')
    }

    const radicals = new Set(mode === 'GUIDED' ? guide.flatMap((stroke, index) => (stroke.is_radical ? [index] : [])) : [])
    const items = toItems(glyph, radicals)
    const url = `image:sha256:${request.image.sha256}`
    const destination: ConversionDestination = existing.length > 0 ? 'STROKES' : 'WORKING'
    const svg = animatedSvg(unicode, items.map((item) => item.outline_path), items.map((item) => item.median_points), items.map((item) => item.stroke_width))

    transaction(db, () => {
      if (destination === 'STROKES') {
        strokes.writeStrokes(unicode, items, ACTOR_USER, ACTION_IMAGE, { source: ORIGIN_MANUAL, url }, glyph.fontOutline)
        db.prepare('DELETE FROM working_data WHERE char = ?').run(char)
        setCharacterStrokeCount(db, unicode, items.length, ACTOR_USER)
        issues.clearIssue(unicode)
      } else {
        strokes.writeWorking(unicode, { source: ORIGIN_MANUAL, url, fontOutline: glyph.fontOutline ?? request.contours, items }, ACTOR_USER)
        const previous = db.prepare('SELECT in_font FROM issues WHERE char = ?').get(char) as { in_font: number } | undefined
        issues.setIssue(unicode, ISSUE_REASON_IMAGE, ACTOR_USER, 'DRAFT', previous?.in_font === 1)
      }
      recordConversion(char, request, { mode, destination, strokeCount: items.length, svg })
    })
    return { mode, destination, strokeCount: items.length }
  }

  // 글자의 변환 이력(최근 것이 먼저). 결과 SVG까지 담는다.
  function listConversions(unicode: string): ConversionRow[] {
    const { char } = strokes.requireCharacter(unicode)
    return db.prepare('SELECT * FROM conversions WHERE char = ? ORDER BY id DESC').all(char).map((row) => ({ ...row })) as ConversionRow[]
  }

  return { importImage, listConversions }
}
