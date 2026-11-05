export type Pt = [number, number]

export type RefSource = 'MMH' | 'IDS' | 'OLLAMA_IDS' | 'MANUAL' | 'NONE'
export type CapType = 'NONE' | 'AUTO_ROUND' | 'REF_STAMP'
export type BackgroundMode = 'outline' | 'silhouette' | 'none'

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
