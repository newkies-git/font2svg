import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_STROKE_WIDTH } from '../shared/constants.ts'
import { orderedGlyph } from './referenceMerge.ts'
import type { Pt, WriteMode } from '../shared/types.ts'
import { parseWriteMode } from '../shared/writeMode.ts'
import { transaction } from './db.ts'
import { ribbonPath, type ImportedStrokes } from './geometry.ts'
import { askOllama, IDS_BOOK, IDS_FILE, OLLAMA_MODEL, ollamaUrl, parseIds, parseIdsFile } from './ids.ts'
import { composeFrom, type IdsLookup } from './idsCompose.ts'
import { parseStringArray } from './storedJson.ts'
import { ACTOR_USER } from './model.ts'
import { hanjaStrokes, parseHanja } from './references.ts'
import { toItems, type StrokeStore } from './strokeStore.ts'

const ORIGIN_OLLAMA_IDS = 'OLLAMA_IDS'

type IssueWriter = {
  setIssue: (unicode: string, reason: string, by: string, status?: 'OPEN' | 'DRAFT', inFont?: boolean) => void
}

type FitResult = {
  glyph: ImportedStrokes
  unmatched: number[]
  status: 'fitted' | 'partial' | 'copied' | 'no-font'
}

export type OllamaIdsPreview = {
  char: string
  model: string
  ids: string | null
  valid: boolean
  composable: boolean
  strokeCount: number
}

export function createOllamaIdsPipeline(
  db: DatabaseSync,
  rootDir: string,
  deps: {
    strokes: StrokeStore
    issues: IssueWriter
    fitOrGiven: (char: string, medians: Pt[][], outlines: string[]) => FitResult
  },
) {
  const { strokes, issues, fitOrGiven } = deps
  let idsFileIndex: Map<string, string[]> | undefined

  function getIdsFileIndex(): Map<string, string[]> {
    if (idsFileIndex) return idsFileIndex
    const file = path.join(rootDir, IDS_FILE)
    if (!fs.existsSync(file)) {
      idsFileIndex = new Map()
      return idsFileIndex
    }
    idsFileIndex = parseIdsFile(fs.readFileSync(file, 'utf8'))
    return idsFileIndex
  }

  function createLookup(): IdsLookup {
    const fileIndex = getIdsFileIndex()
    return {
      knownMedians(char: string): Pt[][] {
        const strokeRow = db.prepare('SELECT stroke_outlines, median_line FROM strokes WHERE char = ?').get(char) as { stroke_outlines?: string; median_line?: string } | undefined
        if (strokeRow?.stroke_outlines && strokeRow?.median_line) {
          const items = strokes.itemsOf({ stroke_outlines: strokeRow.stroke_outlines, median_line: strokeRow.median_line })
          if (items.length > 0) return items.map((item) => item.median_points)
        }

        const workRow = db.prepare('SELECT stroke_outlines, median_line FROM working_data WHERE char = ?').get(char) as { stroke_outlines?: string; median_line?: string } | undefined
        if (workRow?.stroke_outlines && workRow?.median_line) {
          const items = strokes.itemsOf({ stroke_outlines: workRow.stroke_outlines, median_line: workRow.median_line })
          if (items.length > 0) return items.map((item) => item.median_points)
        }

        const refRows = db.prepare(`
          SELECT r.source, r.raw_data
          FROM reference_data r
          JOIN characters c ON c.unicode = r.unicode
          WHERE c.char = ? AND r.found = 1 AND r.raw_data IS NOT NULL
        `).all(char) as Array<{ source: string; raw_data: string }>
        const glyphOf = (source: string) => {
          const row = refRows.find((item) => item.source === source)
          return row ? parseHanja(row.raw_data) : null
        }
        // 획순은 NAVER, 모양은 Hanzi를 따른다(orderedGlyph). NAVER가 없으면 Hanzi를 그대로 쓴다.
        const naver = glyphOf('NAVER')
        const merged = naver ? orderedGlyph(naver, glyphOf('MMH')) : null
        if (merged) return merged.medians
        const mmh = glyphOf('MMH')
        const imported = mmh ? hanjaStrokes(mmh) : null
        return imported && imported.medians.length > 0 ? imported.medians : []
      },
      decompositions(char: string): string[] {
        const manual = IDS_BOOK[char]
        const fromFile = fileIndex.get(char) ?? []
        return manual ? [manual, ...fromFile] : fromFile
      },
    }
  }

  function currentFontOutline(unicode: string): string[] {
    const working = strokes.readWorkingRow(unicode)
    return working?.font_outline ? parseStringArray(working.font_outline, '궁서체 윤곽') : []
  }

  async function inferIds(unicode: string, options: { model?: string; ids?: string } = {}): Promise<OllamaIdsPreview> {
    const character = strokes.requireCharacter(unicode)
    const model = options.model?.trim() || OLLAMA_MODEL
    const rawIds = options.ids !== undefined ? options.ids.trim() : await askOllama(character.char, model)
    const ids = rawIds || null
    if (!ids) {
      return { char: character.char, model, ids: null, valid: false, composable: false, strokeCount: 0 }
    }
    const parsed = parseIds(ids)
    const valid = Boolean(parsed && !('leaf' in parsed))
    const composed = valid ? composeFrom(ids, createLookup()) : null
    return {
      char: character.char,
      model,
      ids,
      valid,
      composable: Boolean(composed && composed.length > 0),
      strokeCount: composed?.length ?? 0,
    }
  }

  async function applyIds(
    unicode: string,
    options: { model?: string; ids?: string; write?: WriteMode } = {},
  ): Promise<FitResult & { ids: string; model: string }> {
    const character = strokes.requireCharacter(unicode)
    const model = options.model?.trim() || OLLAMA_MODEL
    const write = parseWriteMode(options.write)
    const rawIds = options.ids?.trim() || (await askOllama(character.char, model))
    if (!rawIds) {
      throw new Error('로컬 Ollama에서 IDS를 추론하지 못했습니다. Ollama 실행 상태와 모델을 확인하거나 IDS를 직접 입력하세요.')
    }
    const parsed = parseIds(rawIds)
    if (!parsed || 'leaf' in parsed) {
      throw new Error(`유효한 IDS 구조식이 아닙니다: "${rawIds}" (예: ⿰木木, ⿱水田)`)
    }
    const medians = composeFrom(rawIds, createLookup())
    if (!medians || medians.length === 0) {
      throw new Error(`IDS "${rawIds}"의 부품 획 데이터를 DB에서 찾을 수 없어 합성할 수 없습니다.`)
    }

    const outlines = medians.map((m) => ribbonPath(m, DEFAULT_STROKE_WIDTH))
    const fitted = fitOrGiven(character.char, medians, outlines)
    const items = toItems(fitted.glyph, new Set())
    const originUrl = ollamaUrl('/api/generate')
    const fontOutline = fitted.glyph.fontOutline ?? currentFontOutline(unicode)

    const kept = strokes.appendStrokes(unicode, write, items, 'Ollama IDS')
    if (kept !== null) return { ...fitted, unmatched: fitted.unmatched.map((order) => order + kept), ids: rawIds, model }

    if (strokes.readStrokeRow(unicode)) {
      transaction(db, () => {
        strokes.replaceStrokes(
          unicode,
          items,
          ACTOR_USER,
          'Ollama IDS 적용',
          { source: ORIGIN_OLLAMA_IDS, url: originUrl },
          fontOutline.length > 0 ? fontOutline : undefined,
        )
      })
      return { ...fitted, ids: rawIds, model }
    }

    transaction(db, () => {
      strokes.writeWorking(
        unicode,
        { source: ORIGIN_OLLAMA_IDS, url: originUrl, fontOutline, items },
        ACTOR_USER,
      )
      issues.setIssue(unicode, `Ollama IDS 합성 (${rawIds})`, ACTOR_USER, 'DRAFT', fontOutline.length > 0)
    })
    return { ...fitted, ids: rawIds, model }
  }

  return {
    inferIds,
    applyIds,
  }
}
