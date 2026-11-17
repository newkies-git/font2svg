import type { DatabaseSync } from 'node:sqlite'

// 글자(characters 행)의 마지막 수정자만 바꾼다. 수정 시각은 DB 트리거가 갱신한다.
export function markCharacterEdited(db: DatabaseSync, unicode: string, by: string): void {
  db.prepare('UPDATE characters SET last_modified_by = ? WHERE unicode = ?').run(by, unicode)
}

// 글자의 획 수와 마지막 수정자를 함께 바꾼다. 획이 바뀌는 저장·승인·되돌리기·가져오기가 같은 규칙을 쓴다.
export function setCharacterStrokeCount(db: DatabaseSync, unicode: string, strokeCount: number, by: string): void {
  db.prepare('UPDATE characters SET stroke_count = ?, last_modified_by = ? WHERE unicode = ?').run(strokeCount, by, unicode)
}
