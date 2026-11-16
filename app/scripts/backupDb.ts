import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { BACKUP_TAG } from '../src/lib/constants.ts'
import { backupDatabase, backupPathFor } from '../server/dbBackup.ts'

// 사용법: npm run backup [-- <복사본을 둘 폴더>]
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dbPath = path.join(appDir, '..', 'database', 'chusa1817.db')
const targetDir = process.argv[2] ? path.resolve(process.argv[2]) : path.dirname(dbPath)

const db = new DatabaseSync(dbPath, { readOnly: true })
try {
  const destination = path.join(targetDir, path.basename(backupPathFor(dbPath, BACKUP_TAG)))
  const result = backupDatabase(db, destination)
  console.log(`백업 완료: ${result.path} (${(result.bytes / (1024 * 1024)).toFixed(1)}MB, 무결성 ok)`)
} finally {
  db.close()
}
