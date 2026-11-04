export type Pt = [number, number]

export type CharStatus = 'TODO' | 'AUTO_MATCHED' | 'AI_ASSISTED' | 'ISSUE' | 'DONE'
export type RefSource = 'MMH' | 'KANJIVG' | 'OLLAMA_IDS' | 'MANUAL' | 'NONE'
export type IdsSource = 'CHISE' | 'BABELSTONE' | 'OLLAMA' | 'MANUAL'
export type CapType = 'NONE' | 'AUTO_ROUND' | 'REF_STAMP'
export type BackgroundMode = 'outline' | 'silhouette' | 'none'

export type RadicalInfo = {
  id: number
  radical_char: string
  variant_chars: string[]
  name_kr: string
  stroke_count: number
}

export type CharacterSummary = {
  unicode: string
  char: string
  grade: string | null
  status: CharStatus
  issue_reason: string | null
  ref_source: RefSource
  radical_id: number | null
  radical_form: string | null
  korean_reading: string | null
  stroke_count: number
  updated_at: string
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
  status: CharStatus
  issue_reason: string | null
  raw_ttf_path: string
  ref_source: RefSource
  ref_url: string | null
  radical_id: number | null
  radical_form: string | null
  korean_reading: string | null
  ids_structure: string | null
  ids_source: IdsSource | null
  ai_stroke_count: number | null
  stroke_count: number
  compiled_json: CompiledGlyphJson | null
  strokes: StrokeRecord[]
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
