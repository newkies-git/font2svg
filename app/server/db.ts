import type { DatabaseSync } from 'node:sqlite'

// 연결별 트랜잭션 깊이. 0이면 트랜잭션 밖이다.
const depthByDb = new WeakMap<DatabaseSync, number>()

// BEGIN ... COMMIT. 도중에 던지면 ROLLBACK하고 같은 오류를 다시 던진다.
// 이미 트랜잭션 안이면 SAVEPOINT로 중첩한다: 안쪽이 실패하면 안쪽 변경만 되돌리고 오류를 다시 던진다
// (바깥이 그 오류를 잡지 않으면 바깥도 함께 ROLLBACK된다).
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  const depth = depthByDb.get(db) ?? 0
  const savepoint = `sp_${depth}`
  db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`)
  depthByDb.set(db, depth + 1)
  try {
    const result = work()
    db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`)
    return result
  } catch (error) {
    db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`)
    throw error
  } finally {
    depthByDb.set(db, depth)
  }
}
