import type { DatabaseSync } from 'node:sqlite'

export function createIssues(db: DatabaseSync) {
  function setIssue(unicode: string, reason: string, by: string, status: 'OPEN' | 'DRAFT' = 'OPEN', inFont = false) {
    db.prepare('UPDATE characters SET last_modified_by = ? WHERE unicode = ?').run(by, unicode)
    db.prepare(`
      INSERT INTO issues (char, reason, status, in_font) SELECT char, ?, ?, ? FROM characters WHERE unicode = ?
      ON CONFLICT(char) DO UPDATE SET reason = excluded.reason, status = excluded.status, in_font = excluded.in_font, created_at = CURRENT_TIMESTAMP
    `).run(reason, status, inFont ? 1 : 0, unicode)
  }

  // 승인된 기록('APPROVED')은 남긴다.
  function clearIssue(unicode: string) {
    db.prepare(`DELETE FROM issues WHERE char = (SELECT char FROM characters WHERE unicode = ?) AND status <> 'APPROVED'`).run(unicode)
  }

  return { setIssue, clearIssue }
}
