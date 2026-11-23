import type { CAP_TYPES } from './constants.ts'

export type Pt = [number, number]

type RefSource = 'MMH' | 'NAVER' | 'IDS' | 'OLLAMA_IDS' | 'MANUAL' | 'FONT' | 'NONE'
export type IssueStatus = 'OPEN' | 'DRAFT' | 'APPROVED'
export type FitStatus = 'fitted' | 'partial' | 'copied' | 'no-font'
export type CapType = (typeof CAP_TYPES)[number]
// 가져온 획을 작업 획에 반영하는 방식: 교체 또는 기존 획 뒤에 추가.
export type WriteMode = 'replace' | 'append'
export type ThemeMode = 'system' | 'light' | 'dark'
export type StatusFilter = 'ALL' | IssueStatus

export type LayerKind = 'FONT' | 'OUTLINE' | 'MMH' | 'NAVER' | 'STROKES' | 'MEDIANS' | 'NUMBERS' | 'CUSTOM'
export type LayerColor = 'none' | 'ink' | 'slate' | 'blue' | 'violet' | 'green' | 'amber' | 'rose'
export type EditorTool = 'select' | 'bezier' | 'median' | 'knife' | 'connect'
// 칼 도구의 모드: cut은 칼 선으로 자르기, extract는 안내선을 따라 획을 뽑는 교차 분리
export type KnifeMode = 'cut' | 'extract'

export type CharacterSummary = {
  unicode: string
  char: string
  grade: string | null
  issue_reason: string | null
  issue_status: IssueStatus | null
  in_font: 0 | 1
  origin: RefSource
  reading: string | null
  meaning: string | null
  stroke_count: number
  last_modified_at: string
  last_modified_by: string
}

export type StrokeRecord = {
  stroke_order: number
  outline_path: string
  median_points: Pt[]
  stroke_width: number
  is_radical: 0 | 1
  start_cap_type: CapType
  end_cap_type: CapType
  // OUTLINE 레이어 전용: 이 획이 매핑된 궁서체(font) 레이어의 윤곽 인덱스. 비어 있으면 미매핑.
  font_contours?: number[]
  // 1이면 사람이 직접 매핑한 획이라 자동 매핑이 덮어쓰지 않는다.
  map_manual?: 0 | 1
  // 매핑을 만들 때의 궁서체 윤곽 지문. 현재 윤곽의 지문과 다르면 font_contours 인덱스가 어긋났을 수 있다.
  font_hash?: string
}

export type LayerRecord = {
  id: string
  kind: LayerKind
  name: string
  z_index: number
  visible: boolean
  opacity: number
  locked: boolean
  label_color: LayerColor
  available: boolean
  modified: boolean
  source_url: string | null
  strokes: StrokeRecord[]
  paths: string[]
  // OUTLINE 전용: 궁서체 윤곽이 바뀌어 매핑 인덱스가 어긋났을 수 있음
  stale?: boolean
}

export type LayerMetaPatch = {
  id: string
  name?: string
  z_index?: number
  visible?: boolean
  opacity?: number
  locked?: boolean
  label_color?: LayerColor
}

type CompiledRadical = {
  id: number
  char: string
  origin: string | null
  name: string
  strokeIndices: number[]
}

export type CompiledGlyphJson = {
  schemaVersion: 1
  character: string
  unicode: string
  reading: string
  strokeCount: number
  coordinateSystem: { size: number; yAxis: 'up' }
  radical: CompiledRadical | null
  fullOutline: string
  strokes: string[]
  medians: Pt[][]
  strokeWidths: number[]
  source: { outline: string; medians: string }
}

export type CharacterDetail = {
  unicode: string
  char: string
  grade: string | null
  issue_reason: string | null
  issue_status: IssueStatus | null
  in_font: 0 | 1
  working: boolean
  reading: string | null
  meaning: string | null
  variant_reading: string[]
  variant_meaning: string[]
  stroke_count: number
  radical: number
  font_outline: string[]
  origin: RefSource | null
  origin_url: string | null
  last_modified_at: string
  last_modified_by: string
  strokes: StrokeRecord[]
  layers: LayerRecord[]
  history_count: number
}

export type AppliedCharacterDetail = CharacterDetail & {
  fit_status?: FitStatus
  unmatched_strokes?: number[]
}

export type OllamaStatus = {
  connected: boolean
  models: string[]
  defaultModel: string
  url: string
  error?: string
}

export type OllamaIdsPreview = {
  char: string
  model: string
  ids: string | null
  valid: boolean
  composable: boolean
  strokeCount: number
}

type ChatRole = 'user' | 'assistant'
export type ChatMessage = { role: ChatRole; content: string }
export type ChatMode = 'chat' | 'edit'

// 사용자가 지금 보고 있는 글자(채팅 모델에 알려 주는 정보)
export type ChatCurrent = { unicode: string; char: string }

// 모델이 제안하는 데이터 수정. stroke는 1부터 센 획 번호다.
export type ChatEdit =
  | { op: 'set_radical'; stroke: number; value: 0 | 1 }
  | { op: 'set_cap'; stroke: number; end: 'start' | 'end'; value: CapType }
  | { op: 'reverse'; stroke: number }
  | { op: 'move'; stroke: number; delta: number }
  | { op: 'delete'; stroke: number }
  | { op: 'merge_next'; stroke: number }

// 모델이 도구로 등록한 수정 제안. 사용자가 승인해야 DB에 반영된다.
export type ChatProposal = { unicode: string; char: string; edits: ChatEdit[] }

export type ChatReply = { reply: string; proposals: ChatProposal[]; toolLog: string[]; model: string }

export type ConversionRecord = {
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

