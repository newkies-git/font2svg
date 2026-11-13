import type { DatabaseSync } from 'node:sqlite'

// BEGIN ... COMMIT. 도중에 던지면 ROLLBACK하고 같은 오류를 다시 던진다. 중첩해서 쓰지 않는다.
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec('BEGIN')
  try {
    const result = work()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
