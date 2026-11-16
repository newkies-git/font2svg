import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const PAD_TWO = 2

function pad(value: number): string {
  return String(value).padStart(PAD_TWO, '0')
}

// 20261116-110432 형식(로컬 시각)
export function timestampOf(date: Date): string {
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  return `${day}-${time}`
}

// chusa1817.db → chusa1817.<label>-<timestamp>.db (같은 폴더)
export function backupPathFor(dbPath: string, label: string, date = new Date()): string {
  const { dir, name, ext } = path.parse(dbPath)
  return path.join(dir, `${name}.${label}-${timestampOf(date)}${ext}`)
}

// 열려 있는 DB를 일관된 스냅샷으로 복사한다(WAL 변경 포함). 기존 파일을 덮어쓰지 않고, 복사본의 무결성을 검사한다.
export function backupDatabase(db: DatabaseSync, destination: string): { path: string; bytes: number } {
  if (fs.existsSync(destination)) throw new Error(`백업 파일이 이미 있습니다: ${destination}`)
  db.prepare('VACUUM INTO ?').run(destination)
  const copy = new DatabaseSync(destination, { readOnly: true })
  try {
    const check = copy.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
    if (check.integrity_check !== 'ok') throw new Error(`백업 무결성 검사 실패: ${check.integrity_check}`)
  } finally {
    copy.close()
  }
  return { path: destination, bytes: fs.statSync(destination).size }
}
