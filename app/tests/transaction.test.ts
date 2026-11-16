import assert from 'node:assert/strict'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { transaction } from '../server/db.ts'

function memoryDb() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE t (n INTEGER)')
  return db
}
const rows = (db: DatabaseSync) => (db.prepare('SELECT n FROM t ORDER BY n').all() as { n: number }[]).map((r) => r.n)

test('성공하면 커밋한다', () => {
  const db = memoryDb()
  transaction(db, () => db.exec('INSERT INTO t VALUES (1)'))
  assert.deepEqual(rows(db), [1])
})

test('던지면 되돌리고 같은 오류를 다시 던진다', () => {
  const db = memoryDb()
  assert.throws(() => transaction(db, () => { db.exec('INSERT INTO t VALUES (1)'); throw new Error('실패') }), { message: '실패' })
  assert.deepEqual(rows(db), [])
})

test('반환값을 돌려준다', () => {
  assert.equal(transaction(memoryDb(), () => 42), 42)
})

test('중첩: 둘 다 성공하면 함께 커밋', () => {
  const db = memoryDb()
  transaction(db, () => {
    db.exec('INSERT INTO t VALUES (1)')
    transaction(db, () => db.exec('INSERT INTO t VALUES (2)'))
  })
  assert.deepEqual(rows(db), [1, 2])
})

test('중첩: 안쪽 오류가 바깥까지 번지면 전부 되돌린다', () => {
  const db = memoryDb()
  assert.throws(() => transaction(db, () => {
    db.exec('INSERT INTO t VALUES (1)')
    transaction(db, () => { db.exec('INSERT INTO t VALUES (2)'); throw new Error('안쪽 실패') })
  }), { message: '안쪽 실패' })
  assert.deepEqual(rows(db), [])
})

test('중첩: 바깥이 안쪽 오류를 잡으면 안쪽 변경만 되돌린다', () => {
  const db = memoryDb()
  transaction(db, () => {
    db.exec('INSERT INTO t VALUES (1)')
    try {
      transaction(db, () => { db.exec('INSERT INTO t VALUES (2)'); throw new Error('안쪽 실패') })
    } catch { /* 안쪽 실패를 의도적으로 삼킨다 */ }
    db.exec('INSERT INTO t VALUES (3)')
  })
  assert.deepEqual(rows(db), [1, 3])
})

test('3중 중첩과 실패 뒤 다시 쓰기', () => {
  const db = memoryDb()
  transaction(db, () => transaction(db, () => transaction(db, () => db.exec('INSERT INTO t VALUES (1)'))))
  assert.deepEqual(rows(db), [1])
  assert.throws(() => transaction(db, () => { throw new Error('x') }))
  transaction(db, () => db.exec('INSERT INTO t VALUES (2)'))
  assert.deepEqual(rows(db), [1, 2], '실패 뒤에도 깊이가 어긋나지 않는다')
})
