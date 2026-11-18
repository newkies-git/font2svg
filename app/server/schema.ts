// DB 스키마의 공개 진입점. 구현은 schema/ 아래에 있다.
//   ddl       테이블 정의(DDL)와 행 타입
//   upgrades  마이그레이션 단계(v2: 옛 형식 보정, v3: 변환 이력 테이블)
//   migrate   버전 목록(MIGRATIONS)과 적용기, 적용 전 자동 백업
//   seed      기본 데이터(부수, 프로젝트 메타)
export { NO_FONT_SHA256, type CharacterLayerRow, type CharacterRow, type ConversionRow, type StrokeRow } from './schema/ddl.ts'
export { MIGRATIONS, migrate, SCHEMA_VERSION } from './schema/migrate.ts'
export { seed } from './schema/seed.ts'
