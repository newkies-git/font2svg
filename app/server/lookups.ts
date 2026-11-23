import type { DatabaseSync } from 'node:sqlite'
import type { ReferenceKind } from '../shared/layerKind.ts'

// 여러 모듈이 같은 모양으로 읽던 조회를 한곳에 둔다.

// 외부 레퍼런스(MMH·네이버)를 받아 둔 기록. found가 0이면 "그 출처에 없음"을 캐시한 것이다.
export type ReferenceRow = { found: number; raw_data: string | null; source_url: string | null }

export function readReferenceRow(db: DatabaseSync, unicode: string, source: ReferenceKind): ReferenceRow | undefined {
  return db.prepare('SELECT found, raw_data, source_url FROM reference_data WHERE unicode = ? AND source = ?')
    .get(unicode, source) as ReferenceRow | undefined
}

export type CharacterKey = { unicode: string; char: string }

// 유니코드 순서로 after 다음부터 limit자. 일괄 작업이 이어서 처리할 때 쓴다.
export function charactersAfter(db: DatabaseSync, after: string, limit: number): CharacterKey[] {
  return db.prepare('SELECT unicode, char FROM characters WHERE unicode > ? ORDER BY unicode LIMIT ?')
    .all(after, limit) as CharacterKey[]
}
