import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { CANVAS } from '../shared/constants.ts'
import type { Pt } from '../shared/types.ts'
import { animatedSvg } from './animSvg.ts'
import { ACTOR_USER } from './model.ts'
import { KANGXI_RADICALS } from './radicals.ts'

export function validate(_char: string, strokes: { outline_path: string; median_points: Pt[]; is_radical: number }[]): string[] {
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

function charFile(dir: string, char: string, extension = 'json'): string {
  if ([...char].length !== 1) throw new Error('한자 1자만 저장할 수 있습니다.')
  const file = path.resolve(dir, `${char}.${extension}`)
  if (!file.startsWith(path.resolve(dir) + path.sep)) throw new Error('경로가 올바르지 않습니다.')
  return file
}

type CompiledCharacter = {
  char: string
  working: boolean
  reading: string | null
  radical: number
  font_outline: string[]
  origin: string | null
  origin_url: string | null
  strokes: { stroke_order: number; outline_path: string; median_points: Pt[]; stroke_width: number; is_radical: number }[]
}

export function createCompileOutput(
  db: DatabaseSync,
  compiledDir: string,
  deps: {
    getCharacter: (unicode: string) => CompiledCharacter | null
    setIssue: (unicode: string, reason: string, by: string, status?: 'OPEN' | 'DRAFT', inFont?: boolean) => void
    clearIssue: (unicode: string) => void
  },
) {
  const { getCharacter, setIssue, clearIssue } = deps

  function compile(unicode: string) {
    const detail = getCharacter(unicode)
    if (!detail) throw new Error('등록되지 않은 글자입니다.')
    if (detail.working) throw new Error('승인 전 작업 데이터는 컴파일할 수 없습니다. 먼저 승인하세요.')
    const strokes = detail.strokes
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

  return { compile }
}
