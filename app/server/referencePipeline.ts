import { warnOnce } from '../shared/log.ts'
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { REFERENCE_PREFETCH_CONCURRENCY } from '../shared/constants.ts'
import { isReferenceKind, type ReferenceKind } from '../shared/layerKind.ts'
import type { Pt, WriteMode } from '../shared/types.ts'
import { setReferenceStrokeCount } from './characterWrites.ts'
import { transaction } from './db.ts'
import type { ImportedStrokes } from './geometry.ts'
import {
  ACTION_NAVER,
  ACTOR_FONT,
  ACTOR_HANJA,
  ACTOR_NAVER,
  ACTOR_USER,
} from './model.ts'
import { readReferenceRow } from './lookups.ts'
import {
  fetchHanja,
  fetchNaver,
  HANJA_VERSION,
  hanjaStrokes,
  hanjaUrl,
  NAVER_VERSION,
  naverUrl,
  parseHanja,
  type Found,
  type HanjaGlyph,
  type Remote,
} from './references.ts'
import { toItems, type StrokeStore } from './strokeStore.ts'

type IssueWriter = {
  setIssue: (unicode: string, reason: string, by: string, status?: 'OPEN' | 'DRAFT', inFont?: boolean) => void
  clearIssue: (unicode: string) => void
}

// 일괄 수신하는 출처와 글자별 주소·내려받기. 이미 받은 글자는 건너뛰므로 끊겨도 이어서 받을 수 있다.
export type PrefetchSource = Extract<ReferenceKind, 'MMH' | 'NAVER'>
export const PREFETCH_ORDER: readonly PrefetchSource[] = ['MMH', 'NAVER']
const PREFETCHERS: Record<PrefetchSource, { url: (char: string) => string; fetch: (char: string) => Promise<Remote<HanjaGlyph>> }> = {
  MMH: { url: hanjaUrl, fetch: fetchHanja },
  NAVER: { url: naverUrl, fetch: fetchNaver },
}

export type PrefetchOptions = {
  concurrency?: number
  // 이전에 "없음"으로 기록된 글자도 다시 받는다.
  retryMissing?: boolean
  onProgress?: (done: number, total: number) => void
}

export type PrefetchSummary = {
  source: PrefetchSource
  // 전체 글자 수와 그중 이미 저장돼 있어 건너뛴 수
  total: number
  cached: number
  // 이번에 받은 결과: 있음·없음, 받지 못한 글자(네트워크 오류 등, 저장되지 않아 다시 실행하면 이어서 받는다)
  found: number
  missing: number
  failed: string[]
}

// 레퍼런스 종류별 원본 버전과 가져온 데이터의 기록자.
const REFERENCE_VERSION: Record<ReferenceKind, string> = { MMH: HANJA_VERSION, NAVER: NAVER_VERSION }
const REFERENCE_ACTOR: Record<ReferenceKind, string> = { MMH: ACTOR_HANJA, NAVER: ACTOR_NAVER }

export function createReferencePipeline(
  db: DatabaseSync,
  deps: {
    strokes: StrokeStore
    issues: IssueWriter
    fitOrGiven: (char: string, medians: Pt[][], outlines: string[]) => {
      glyph: ImportedStrokes
      unmatched: number[]
      status: 'fitted' | 'partial' | 'copied' | 'no-font'
    }
  },
) {
  const { strokes, issues, fitOrGiven } = deps

  async function loadSource<T>(unicode: string, source: ReferenceKind, url: string, fetchFresh: () => Promise<Remote<T>>): Promise<Found<T> | null> {
    const cached = readReferenceRow(db, unicode, source)
    if (cached) {
      if (!cached.source_url) db.prepare('UPDATE reference_data SET source_url = ? WHERE unicode = ? AND source = ?').run(url, unicode, source)
      if (!cached.found || !cached.raw_data) return null
      const value = parseHanja(cached.raw_data) as T | null
      return value ? { url: cached.source_url || url, raw: cached.raw_data, value } : null
    }
    try {
      const fresh = await fetchFresh()
      db.prepare(`
        INSERT INTO reference_data (unicode, source, source_version, source_url, raw_data, raw_sha256, found)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        unicode,
        source,
        REFERENCE_VERSION[source],
        fresh.url,
        fresh.value ? fresh.raw : null,
        fresh.value ? createHash('sha256').update(fresh.raw).digest('hex') : null,
        fresh.value ? 1 : 0,
      )
      if (source === 'NAVER' && fresh.value) adoptNaverStrokeCount(unicode, fresh.raw)
      return fresh.value ? { ...fresh, value: fresh.value } : null
    } catch (error) {
      // 네트워크 실패나 캐시 저장 실패. 이 글자는 이번에 "레퍼런스 없음"으로 넘어가고 다음 요청에서 다시 시도한다.
      warnOnce(`reference:${source}`, error)
      return null
    }
  }

  // 아직 저장되지 않은 글자만 source에서 받아 reference_data에 쓴다. 글자 수만큼 요청하므로 concurrency개씩 나눠 받는다.
  async function prefetchSource(source: PrefetchSource, options: PrefetchOptions = {}): Promise<PrefetchSummary> {
    const { concurrency = REFERENCE_PREFETCH_CONCURRENCY, retryMissing = false, onProgress } = options
    const prefetcher = PREFETCHERS[source]
    if (retryMissing) db.prepare('DELETE FROM reference_data WHERE source = ? AND found = 0').run(source)
    const total = (db.prepare('SELECT COUNT(*) AS n FROM characters').get() as { n: number }).n
    const todo = db.prepare(`
      SELECT c.unicode, c.char FROM characters c
      LEFT JOIN reference_data r ON r.unicode = c.unicode AND r.source = ?
      WHERE r.unicode IS NULL ORDER BY c.unicode
    `).all(source) as { unicode: string; char: string }[]
    const summary: PrefetchSummary = { source, total, cached: total - todo.length, found: 0, missing: 0, failed: [] }
    let next = 0
    let done = 0
    const worker = async () => {
      for (let index = next++; index < todo.length; index = next++) {
        const { unicode, char } = todo[index]
        await loadSource(unicode, source, prefetcher.url(char), () => prefetcher.fetch(char))
        const saved = readReferenceRow(db, unicode, source)
        if (!saved) summary.failed.push(char)
        else if (saved.found) summary.found += 1
        else summary.missing += 1
        onProgress?.(++done, todo.length)
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker))
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return summary
  }

  // 출처를 순서대로(기본은 Hanzi → 네이버) 하나씩 끝낸 뒤 다음으로 넘어간다.
  async function prefetchReferences(sources: readonly PrefetchSource[] = PREFETCH_ORDER, options: PrefetchOptions = {}): Promise<PrefetchSummary[]> {
    const summaries: PrefetchSummary[] = []
    for (const source of sources) summaries.push(await prefetchSource(source, options))
    return summaries
  }

  function saveImported(unicode: string, source: string, url: string | null, radical: number[], glyph: ImportedStrokes, action = `${source} 가져오기`) {
    const { fontOutline } = glyph
    // 궁서체 윤곽으로 나눠졌으면 궁서체 교체와 같은 상태다(이후 레퍼런스가 중심선을 되덮지 않는다).
    const by = fontOutline ? ACTOR_FONT : isReferenceKind(source) ? REFERENCE_ACTOR[source] : ACTOR_USER
    transaction(db, () => {
      strokes.replaceStrokes(unicode, toItems(glyph, new Set(radical)), by, action, { source, url }, fontOutline)
      issues.clearIssue(unicode)
    })
  }

  // 획순이 틀린 글자를 사람이 지정해 네이버 한자사전 획순으로 바꾼다. 사람이 고친 글자도 바꾸며(실행 취소로 되돌린다),
  // 바뀌기 전 strokes 행은 strokes_history에 남고 같은 글자의 작업 데이터는 지워진다. 네이버에 없으면 아무것도 바꾸지 않는다.
  // write가 append이고 작업 획이 있으면 기존 획 뒤에 붙인다. 비어 있으면 교체와 같다.
  async function applyNaver(unicode: string, write: WriteMode = 'replace') {
    const character = strokes.requireCharacter(unicode)
    const naver = await loadSource(unicode, 'NAVER', naverUrl(character.char), () => fetchNaver(character.char))
    const imported = naver ? hanjaStrokes(naver.value) : null
    if (!naver || !imported) throw new Error('네이버 한자사전에서 이 글자의 획순을 찾지 못했습니다.')
    const fitted = fitOrGiven(character.char, imported.medians, imported.outlines)
    const items = toItems(fitted.glyph, new Set(naver.value.radical))
    const kept = strokes.appendStrokes(unicode, write, items, ACTION_NAVER)
    if (kept !== null) return { unmatched: fitted.unmatched.map((order) => order + kept), status: fitted.status }
    saveImported(unicode, 'NAVER', naver.url, naver.value.radical, fitted.glyph, ACTION_NAVER)
    return { unmatched: fitted.unmatched, status: fitted.status }
  }

  // 획 정보의 기준은 NAVER다. 작업 획(strokes·working_data)이 없는 글자의 획수는 NAVER 획수를 따르고,
  // 작업 획이 있으면 그 획 수가 기준이므로 건드리지 않는다. 바꿨으면 true.
  function adoptNaverStrokeCount(unicode: string, raw: string): boolean {
    const glyph = parseHanja(raw)
    const count = glyph ? glyph.outlines.length || glyph.medians.length : 0
    if (count === 0) return false
    const row = db.prepare(`
      SELECT c.stroke_count AS count,
             EXISTS (SELECT 1 FROM strokes s WHERE s.char = c.char) + EXISTS (SELECT 1 FROM working_data w WHERE w.char = c.char) AS worked
      FROM characters c WHERE c.unicode = ?
    `).get(unicode) as { count: number; worked: number } | undefined
    if (!row || row.worked > 0 || row.count === count) return false
    setReferenceStrokeCount(db, unicode, count)
    return true
  }

  // 이미 저장된 NAVER 원본 전체에 위 규칙을 적용한다. 몇 번을 실행해도 결과가 같다.
  function syncStrokeCountsFromNaver(): { checked: number; updated: number } {
    const rows = db.prepare("SELECT unicode, raw_data FROM reference_data WHERE source = 'NAVER' AND found = 1 AND raw_data IS NOT NULL ORDER BY unicode")
      .all() as { unicode: string; raw_data: string }[]
    let updated = 0
    transaction(db, () => {
      for (const row of rows) if (adoptNaverStrokeCount(row.unicode, row.raw_data)) updated += 1
    })
    return { checked: rows.length, updated }
  }

  return {
    loadSource,
    saveImported,
    applyNaver,
    prefetchReferences,
    syncStrokeCountsFromNaver,
  }
}
