import { warnOnce } from '../shared/log.ts'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ACJK_BATCH_LIMIT, ACJK_FILE_LIMIT } from '../shared/constants.ts'
import { isReferenceKind, type ReferenceKind } from '../shared/layerKind.ts'
import type { Pt, WriteMode } from '../shared/types.ts'
import { transaction } from './db.ts'
import type { ImportedStrokes } from './geometry.ts'
import {
  ACTION_ACJK,
  ACTION_NAVER,
  ACTOR_ACJK,
  ACTOR_FONT,
  ACTOR_HANJA,
  ACTOR_NAVER,
  ACTOR_USER,
} from './model.ts'
import { charactersAfter, readReferenceRow } from './lookups.ts'
import {
  ACJK_BLOB,
  ACJK_RAW,
  ACJK_VARIANTS,
  ACJK_VERSION,
  fetchLimited,
  fetchNaver,
  HANJA_VERSION,
  hanjaStrokes,
  NAVER_VERSION,
  naverUrl,
  parseAcjkLine,
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

// 레퍼런스 종류별 원본 버전과 가져온 데이터의 기록자.
const REFERENCE_VERSION: Record<ReferenceKind, string> = { MMH: HANJA_VERSION, ACJK: ACJK_VERSION, NAVER: NAVER_VERSION }
const REFERENCE_ACTOR: Record<ReferenceKind, string> = { MMH: ACTOR_HANJA, ACJK: ACTOR_ACJK, NAVER: ACTOR_NAVER }

export function createReferencePipeline(
  db: DatabaseSync,
  rootDir: string,
  deps: {
    strokes: StrokeStore
    issues: IssueWriter
    fontOrGiven: (char: string, medians: Pt[][], outlines: string[]) => ImportedStrokes
    fitOrGiven: (char: string, medians: Pt[][], outlines: string[]) => {
      glyph: ImportedStrokes
      unmatched: number[]
      status: 'fitted' | 'partial' | 'copied' | 'no-font'
    }
  },
) {
  const { strokes, issues, fontOrGiven, fitOrGiven } = deps
  let acjkIndex: Map<string, { raw: string; url: string }> | undefined

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
      return fresh.value ? { ...fresh, value: fresh.value } : null
    } catch (error) {
      // 네트워크 실패나 캐시 저장 실패. 이 글자는 이번에 "레퍼런스 없음"으로 넘어가고 다음 요청에서 다시 시도한다.
      warnOnce(`reference:${source}`, error)
      return null
    }
  }

  // 글자별 원본은 graphics 한 줄에 dictionary의 분해식(acjk)을 붙인 JSON이다. 내려받지 못하면 던진다(없는 글자로 기록하지 않기 위해).
  async function loadAcjk(): Promise<Map<string, { raw: string; url: string }>> {
    if (acjkIndex) return acjkIndex
    const read = async (name: string) => {
      const file = path.join(rootDir, 'database', name)
      if (!fs.existsSync(file)) {
        const response = await fetchLimited(`${ACJK_RAW}/${name}`, ACJK_FILE_LIMIT)
        if (!response.ok) throw new Error(`AnimCJK ${name} 응답 ${response.status}`)
        fs.writeFileSync(file, response.text)
      }
      return fs.readFileSync(file, 'utf-8')
    }
    const lines = (text: string) => text.split('\n').filter(Boolean).map(parseAcjkLine)
    const index = new Map<string, { raw: string; url: string }>()
    for (const variant of ACJK_VARIANTS) {
      const graphics = `graphics${variant}.txt`
      const dictionary = new Map(lines(await read(`dictionary${variant}.txt`)).map((entry) => [entry.character, entry.acjk]))
      for (const entry of lines(await read(graphics))) {
        index.set(entry.character, {
          raw: JSON.stringify({ strokes: entry.strokes, medians: entry.medians, acjk: dictionary.get(entry.character) }),
          url: `${ACJK_BLOB}/${graphics}`,
        })
      }
    }
    acjkIndex = index
    return index
  }

  async function fetchAcjk(char: string): Promise<Remote<HanjaGlyph>> {
    const found = (await loadAcjk()).get(char)
    return { url: found?.url ?? ACJK_BLOB, raw: found?.raw ?? '', value: found ? parseHanja(found.raw) : null }
  }

  function saveImported(unicode: string, source: string, url: string | null, radical: number[], glyph: ImportedStrokes, action = `${source} 가져오기`) {
    const { fontOutline } = glyph
    // 궁서체 윤곽으로 나눠졌으면 궁서체 교체와 같은 상태다(이후 레퍼런스가 중심선을 되덮지 않는다).
    const by = fontOutline ? ACTOR_FONT : isReferenceKind(source) ? REFERENCE_ACTOR[source] : ACTOR_ACJK
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

  type AcjkResult = 'REPLACED' | 'EDITED' | 'ALREADY' | 'NOT_IN_ACJK'

  // 이미 있는 글자(strokes 또는 승인 전 작업 데이터)를 AnimCJK 데이터로 바꾼다. 사람이 고친 글자는 건너뛴다.
  // 바뀌기 전 strokes 행은 strokes_history에 남고, 같은 글자의 작업 데이터는 지워진다.
  async function applyAcjk(unicode: string): Promise<AcjkResult> {
    const character = strokes.requireCharacter(unicode)
    const acjk = await loadSource(unicode, 'ACJK', ACJK_BLOB, () => fetchAcjk(character.char))
    const imported = acjk ? hanjaStrokes(acjk.value) : null
    if (!acjk || !imported) return 'NOT_IN_ACJK'
    const current = (db.prepare('SELECT origin, last_modified_by AS by FROM strokes WHERE char = ?').get(character.char) ??
      db.prepare('SELECT source AS origin, last_modified_by AS by FROM working_data WHERE char = ?').get(character.char)) as { origin: string; by: string } | undefined
    if (current?.by === ACTOR_USER) return 'EDITED'
    if (current?.origin === 'ACJK') return 'ALREADY'
    saveImported(unicode, 'ACJK', acjk.url, acjk.value.radical, fontOrGiven(character.char, imported.medians, imported.outlines), ACTION_ACJK)
    return 'REPLACED'
  }

  // after 다음 유니코드부터 limit자를 처리한다. next가 null이면 끝.
  async function applyAcjkBatch(after: string, limit = ACJK_BATCH_LIMIT) {
    const rows = charactersAfter(db, after, limit)
    const counts: Record<AcjkResult, number> = { REPLACED: 0, EDITED: 0, ALREADY: 0, NOT_IN_ACJK: 0 }
    const edited: string[] = []
    for (const row of rows) {
      const result = await applyAcjk(row.unicode)
      counts[result] += 1
      if (result === 'EDITED') edited.push(row.char)
    }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    return { processed: rows.length, counts, edited, next: rows.length === limit ? rows[rows.length - 1].unicode : null }
  }

  return {
    loadSource,
    fetchAcjk,
    saveImported,
    applyNaver,
    applyAcjkBatch,
  }
}
