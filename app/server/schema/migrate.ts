import { backupDatabase, backupPathFor } from '../dbBackup.ts'
import type { DatabaseSync } from 'node:sqlite'
import { PRE_MIGRATION_TAG } from '../../shared/constants.ts'
import { upgradeToV2, upgradeToV3, upgradeToV4 } from './upgrades.ts'

type Migration = {
  // 적용 뒤 PRAGMA user_version에 기록되는 값
  version: number
  name: string
  // 스스로 트랜잭션을 관리한다(외래키 PRAGMA는 트랜잭션 안에서 바꿀 수 없다). 중간에 멈춰도 다시 실행하면 이어지도록 멱등해야 한다.
  up: (db: DatabaseSync) => void
}

// 새 스키마 변경은 여기에 버전을 올려 추가한다. 이미 적용된 항목은 고치지 않는다.
// v1: 버전 기록을 처음 도입한 시점의 DB(별도 코드 없음). v2: v1 이전의 옛 형식 보정 + 레이어 종류 OUTLINE 추가. v3: 변환 이력(conversions) 추가. v4: 참고 출처에서 AnimCJK 제거.
export const MIGRATIONS: readonly Migration[] = [
  { version: 2, name: '옛 형식 보정과 OUTLINE 레이어 종류', up: upgradeToV2 },
  { version: 3, name: '변환 이력 테이블', up: upgradeToV3 },
  { version: 4, name: 'AnimCJK 제거', up: upgradeToV4 },
]

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

function readUserVersion(db: DatabaseSync): number {
  return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
}

function hasCharacterData(db: DatabaseSync): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'characters'`).get())
}

// user_version보다 높은 마이그레이션을 순서대로 적용한다. 기존 DB에 적용할 게 있으면 먼저 백업을 만든다(backupBasePath가 있을 때).
export function migrate(db: DatabaseSync, options: { backupBasePath?: string } = {}) {
  const current = readUserVersion(db)
  if (current > SCHEMA_VERSION) {
    throw new Error(`DB 스키마 버전(${current})이 앱이 아는 버전(${SCHEMA_VERSION})보다 높습니다. 앱을 최신으로 올리세요.`)
  }
  const pending = MIGRATIONS.filter((migration) => migration.version > current)
  if (pending.length === 0) return
  if (options.backupBasePath && hasCharacterData(db)) {
    backupDatabase(db, backupPathFor(options.backupBasePath, `${PRE_MIGRATION_TAG}-v${current}`))
  }
  for (const migration of pending) {
    migration.up(db)
    db.exec(`PRAGMA user_version = ${migration.version}`)
  }
}
