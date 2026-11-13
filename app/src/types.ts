export type Pt = [number, number]

export type RefSource = 'MMH' | 'ACJK' | 'NAVER' | 'IDS' | 'OLLAMA_IDS' | 'MANUAL' | 'FONT' | 'NONE'
export type IssueStatus = 'OPEN' | 'DRAFT' | 'APPROVED'
export type CapType = 'NONE' | 'AUTO_ROUND' | 'REF_STAMP'
export type ThemeMode = 'system' | 'light' | 'dark'
export type StatusFilter = 'ALL' | IssueStatus

export type LayerKind = 'FONT' | 'MMH' | 'ACJK' | 'NAVER' | 'STROKES' | 'MEDIANS' | 'NUMBERS' | 'CUSTOM'
export type LayerColor = 'none' | 'ink' | 'slate' | 'blue' | 'violet' | 'green' | 'amber' | 'rose'
export type EditorTool = 'select' | 'bezier' | 'median' | 'knife' | 'connect'

export type RadicalInfo = {
  id: number
  radical_char: string
  variant_chars: string[]
  reading: string
  meaning: string
  stroke_count: number
}

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

export type CompiledRadical = {
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

export type StrokeType = {
  id: string
  name: string
  dx: number
  dy: number
}

export type StrokeTypeBook = {
  start: StrokeType[]
  end: StrokeType[]
}
