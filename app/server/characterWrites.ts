import type { DatabaseSync } from 'node:sqlite'

// 글자(characters 행)의 마지막 수정자만 바꾼다. 수정 시각은 DB 트리거가 갱신한다.
export function markCharacterEdited(db: DatabaseSync, unicode: string, by: string): void {
  db.prepare('UPDATE characters SET last_modified_by = ? WHERE unicode = ?').run(by, unicode)
}

// 참고 획(NAVER)을 기준으로 획수만 맞춘다. 사람이 고친 게 아니므로 마지막 수정자는 그대로 둔다(폰트 일괄 적용이 수정자로 "이미 적용됨"을 판정한다).
export function setReferenceStrokeCount(db: DatabaseSync, unicode: string, strokeCount: number): void {
  db.prepare('UPDATE characters SET stroke_count = ? WHERE unicode = ?').run(strokeCount, unicode)
}

// 글자의 획 수와 마지막 수정자를 함께 바꾼다. 획이 바뀌는 저장·승인·되돌리기·가져오기가 같은 규칙을 쓴다.
export function setCharacterStrokeCount(db: DatabaseSync, unicode: string, strokeCount: number, by: string): void {
  db.prepare('UPDATE characters SET stroke_count = ?, last_modified_by = ? WHERE unicode = ?').run(strokeCount, by, unicode)
}
