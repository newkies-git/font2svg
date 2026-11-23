import { GRAY_MAX, KANGXI_COUNT, SHA256_HEX_LENGTH } from '../../shared/constants.ts'

export const NO_FONT_SHA256 = '0'.repeat(SHA256_HEX_LENGTH)

export const STROKES_DDL = `
  CREATE TABLE IF NOT EXISTS strokes (
    char TEXT PRIMARY KEY REFERENCES characters(char) ON DELETE CASCADE,
    radical INTEGER NOT NULL DEFAULT 0 CHECK (radical BETWEEN 0 AND ${KANGXI_COUNT}),
    font_outline JSON NOT NULL CHECK (json_valid(font_outline) AND json_type(font_outline) = 'array'),
    stroke_outlines JSON NOT NULL
      CHECK (json_valid(stroke_outlines) AND json_type(stroke_outlines) = 'array' AND json_array_length(stroke_outlines) >= 1),
    median_line JSON NOT NULL
      CHECK (json_valid(median_line) AND json_type(median_line) = 'array' AND json_array_length(median_line) = json_array_length(stroke_outlines)),
    last_modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_modified_by TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('MMH', 'NAVER', 'IDS', 'OLLAMA_IDS', 'MANUAL', 'NONE')),
    origin_url TEXT
  )
`

// strokes가 바뀔 때마다, 바뀌기 전 행을 그대로 남긴다(삭제하지 않는다). 현재 상태는 strokes에 있다.
export const STROKES_HISTORY_DDL = `
  CREATE TABLE IF NOT EXISTS strokes_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    char TEXT NOT NULL REFERENCES characters(char) ON DELETE CASCADE,
    radical INTEGER NOT NULL,
    font_outline JSON NOT NULL CHECK (json_valid(font_outline) AND json_type(font_outline) = 'array'),
    stroke_outlines JSON NOT NULL CHECK (json_valid(stroke_outlines) AND json_type(stroke_outlines) = 'array'),
    median_line JSON NOT NULL CHECK (json_valid(median_line) AND json_type(median_line) = 'array'),
    origin TEXT NOT NULL,
    origin_url TEXT,
    state_modified_at DATETIME NOT NULL,
    state_modified_by TEXT NOT NULL,
    action_desc TEXT NOT NULL,
    changed_by TEXT NOT NULL,
    changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    undoable INTEGER NOT NULL DEFAULT 1 CHECK (undoable IN (0, 1))
  );
  CREATE INDEX IF NOT EXISTS idx_strokes_history_char ON strokes_history(char, id DESC)
`

export type StrokeRow = {
  char: string
  radical: number
  font_outline: string
  stroke_outlines: string
  median_line: string
  last_modified_at: string
  last_modified_by: string
  origin: string
  origin_url: string | null
}

export type CharacterRow = {
  unicode: string
  char: string
  grade: string | null
  reading: string | null
  meaning: string | null
  variant_reading: string
  variant_meaning: string
  stroke_count: number
  last_modified_at: string
  last_modified_by: string
}

export function charactersDdl(name: string): string {
  return `
    CREATE TABLE IF NOT EXISTS ${name} (
      unicode TEXT PRIMARY KEY,
      char TEXT NOT NULL UNIQUE,
      grade TEXT,
      reading TEXT,
      meaning TEXT,
      variant_reading JSON NOT NULL DEFAULT '[]' CHECK (json_valid(variant_reading) AND json_type(variant_reading) = 'array'),
      variant_meaning JSON NOT NULL DEFAULT '[]' CHECK (json_valid(variant_meaning) AND json_type(variant_meaning) = 'array'),
      stroke_count INTEGER NOT NULL DEFAULT 0,
      last_modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_modified_by TEXT NOT NULL
    )
  `
}

// status: OPEN(작업 전) / DRAFT(작업 데이터가 있어 승인 대기) / APPROVED(승인해 strokes로 옮김). in_font: 궁서체에 글리프가 있는지.
export const ISSUE_STATUS_COLUMN = `status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DRAFT', 'APPROVED'))`

export const ISSUE_IN_FONT_COLUMN = 'in_font INTEGER NOT NULL DEFAULT 0 CHECK (in_font IN (0, 1))'

export const ISSUES_DDL = `
  CREATE TABLE IF NOT EXISTS issues (
    char TEXT PRIMARY KEY REFERENCES characters(char) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ${ISSUE_STATUS_COLUMN},
    ${ISSUE_IN_FONT_COLUMN}
  )
`

// Hanja에 없는 글자의 IDS 합성 초안·궁서체 추출 데이터·수작업 데이터. 승인하면 strokes로 옮기고 지운다.
// FONT는 궁서체 윤곽만 있고 획이 없는 경우다.
export const WORKING_DATA_DDL = `
  CREATE TABLE IF NOT EXISTS working_data (
    char TEXT PRIMARY KEY REFERENCES characters(char) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('IDS', 'OLLAMA_IDS', 'MANUAL', 'FONT')),
    source_url TEXT,
    font_outline JSON NOT NULL CHECK (json_valid(font_outline) AND json_type(font_outline) = 'array'),
    stroke_outlines JSON NOT NULL CHECK (json_valid(stroke_outlines) AND json_type(stroke_outlines) = 'array'),
    median_line JSON NOT NULL
      CHECK (json_valid(median_line) AND json_type(median_line) = 'array' AND json_array_length(median_line) = json_array_length(stroke_outlines)),
    last_modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_modified_by TEXT NOT NULL
  )
`

export const CHARACTER_LAYERS_DDL = `
  CREATE TABLE IF NOT EXISTS character_layers (
    char TEXT NOT NULL REFERENCES characters(char) ON DELETE CASCADE,
    layer_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('FONT', 'OUTLINE', 'MMH', 'NAVER', 'STROKES', 'MEDIANS', 'NUMBERS', 'CUSTOM')),
    name TEXT NOT NULL,
    z_index INTEGER NOT NULL,
    visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
    opacity REAL NOT NULL DEFAULT 1.0 CHECK (opacity >= 0 AND opacity <= 1),
    locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
    label_color TEXT NOT NULL DEFAULT 'none',
    strokes_json JSON CHECK (strokes_json IS NULL OR (json_valid(strokes_json) AND json_type(strokes_json) = 'array')),
    paths_json JSON CHECK (paths_json IS NULL OR (json_valid(paths_json) AND json_type(paths_json) = 'array')),
    modified INTEGER NOT NULL DEFAULT 0 CHECK (modified IN (0, 1)),
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (char, layer_id)
  )
`

export type CharacterLayerRow = {
  char: string
  layer_id: string
  kind: string
  name: string
  z_index: number
  visible: number
  opacity: number
  locked: number
  label_color: string
  strokes_json: string | null
  paths_json: string | null
  modified: number
  updated_at: string
}

// 변환 이력: 외부 입력(래스터 이미지 등)을 획 SVG로 바꾼 기록. 원본 이미지 바이트는 두지 않고 SHA-256과 변환 설정, 결과 SVG만 남긴다.
// mode: GUIDED는 이미 있는 중심선을 길잡이로 윤곽을 획별로 나눴고, COMPONENTS는 이어진 덩어리 하나를 획 하나로 본 것이다.
// destination: STROKES는 이미 있던 획을 교체(이력에 남음), WORKING은 승인 전 작업 데이터.
export const CONVERSIONS_DDL = `
  CREATE TABLE IF NOT EXISTS conversions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    char TEXT NOT NULL REFERENCES characters(char) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('IMAGE_TO_SVG')),
    source_name TEXT NOT NULL,
    source_mime TEXT NOT NULL,
    source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = ${SHA256_HEX_LENGTH}),
    source_width INTEGER NOT NULL CHECK (source_width > 0),
    source_height INTEGER NOT NULL CHECK (source_height > 0),
    threshold INTEGER NOT NULL CHECK (threshold BETWEEN 0 AND ${GRAY_MAX}),
    invert INTEGER NOT NULL CHECK (invert IN (0, 1)),
    mode TEXT NOT NULL CHECK (mode IN ('GUIDED', 'COMPONENTS')),
    destination TEXT NOT NULL CHECK (destination IN ('STROKES', 'WORKING')),
    stroke_count INTEGER NOT NULL CHECK (stroke_count >= 1),
    result_svg TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_conversions_char ON conversions(char, id DESC)
`

export type ConversionRow = {
  id: number
  char: string
  kind: string
  source_name: string
  source_mime: string
  source_sha256: string
  source_width: number
  source_height: number
  threshold: number
  invert: number
  mode: string
  destination: string
  stroke_count: number
  result_svg: string
  created_by: string
  created_at: string
}
