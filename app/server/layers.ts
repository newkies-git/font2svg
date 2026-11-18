import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_CUSTOM_LAYER_OPACITY, DEFAULT_STROKE_WIDTH, FONT_FINGERPRINT_LENGTH, LAYER_ID } from '../shared/constants.ts'
import { isReferenceKind, type ReferenceKind } from '../shared/layerKind.ts'
import type { LayerColor, LayerKind, LayerRecord, StrokeRecord } from '../shared/types.ts'
import { ribbonPath, roundPoints } from './geometry.ts'
import { clampOpacity, normalizeColor, parseStoredPaths, parseStoredStrokes } from './layerData.ts'
import { readReferenceRow } from './lookups.ts'
import { hanjaStrokes, parseHanja } from './references.ts'
import type { CharacterLayerRow } from './schema.ts'

export type BuiltinLayerSpec = {
  id: string
  kind: LayerKind
  name: string
  z_index: number
  visible: boolean
  opacity: number
  locked: boolean
  label_color: LayerColor
}

// PhotoCraft 합성 순서: 배열 앞쪽(z_index 작은 값)이 아래쪽 레이어, 패널 UI는 역순(위→아래)으로 표시한다.
export const BUILTIN_LAYERS: readonly BuiltinLayerSpec[] = [
  { id: LAYER_ID.font, kind: 'FONT', name: '궁서체 (TTF)', z_index: 0, visible: true, opacity: 0.35, locked: true, label_color: 'slate' },
  { id: LAYER_ID.outline, kind: 'OUTLINE', name: '획 윤곽 (매핑)', z_index: 1, visible: false, opacity: 0.7, locked: false, label_color: 'rose' },
  { id: LAYER_ID.mmh, kind: 'MMH', name: 'Hanzi (MMH)', z_index: 2, visible: false, opacity: 0.6, locked: true, label_color: 'violet' },
  { id: LAYER_ID.acjk, kind: 'ACJK', name: 'AnimCJK', z_index: 3, visible: false, opacity: 0.6, locked: true, label_color: 'blue' },
  { id: LAYER_ID.naver, kind: 'NAVER', name: '네이버 획순', z_index: 4, visible: false, opacity: 0.65, locked: true, label_color: 'green' },
  { id: LAYER_ID.strokes, kind: 'STROKES', name: '작업 획', z_index: 5, visible: true, opacity: 1.0, locked: false, label_color: 'ink' },
  { id: LAYER_ID.medians, kind: 'MEDIANS', name: '중심선', z_index: 6, visible: true, opacity: 1.0, locked: false, label_color: 'amber' },
  { id: LAYER_ID.numbers, kind: 'NUMBERS', name: '획순 번호', z_index: 7, visible: true, opacity: 1.0, locked: false, label_color: 'rose' },
]

function readCachedRefStrokes(
  db: DatabaseSync,
  unicode: string,
  source: ReferenceKind,
): { strokes: StrokeRecord[]; url: string | null } {
  const row = readReferenceRow(db, unicode, source)
  if (!row || !row.found || !row.raw_data) return { strokes: [], url: row?.source_url ?? null }
  const glyph = parseHanja(row.raw_data)
  const imported = glyph ? hanjaStrokes(glyph) : null
  if (!glyph || !imported) return { strokes: [], url: row.source_url }
  const radicalSet = new Set(glyph.radical)
  const strokes: StrokeRecord[] = imported.medians.map((median, index) => ({
    stroke_order: index + 1,
    outline_path: imported.outlines[index] || ribbonPath(median, DEFAULT_STROKE_WIDTH),
    median_points: roundPoints(median),
    stroke_width: DEFAULT_STROKE_WIDTH,
    is_radical: radicalSet.has(index) ? 1 : 0,
    start_cap_type: 'NONE',
    end_cap_type: 'NONE',
  }))
  return { strokes, url: row.source_url }
}

// 궁서체 윤곽 목록의 지문. 매핑을 만든 뒤 윤곽이 바뀌었는지 비교한다.
export function fontFingerprint(contours: string[]): string {
  return createHash('sha256').update(JSON.stringify(contours)).digest('hex').slice(0, FONT_FINGERPRINT_LENGTH)
}

// 작업에 쓸 궁서체 윤곽: 편집된 궁서체(font) 레이어가 있으면 그 윤곽, 없으면 글자에 저장된 궁서체 윤곽. 없으면 빈 배열.
export function fontContoursOf(detail: { layers: LayerRecord[]; font_outline: string[] }): string[] {
  const fontLayer = detail.layers.find((layer) => layer.id === LAYER_ID.font)
  return fontLayer && fontLayer.paths.length > 0 ? fontLayer.paths : detail.font_outline
}

type LayerBuildParams = {
  unicode: string
  char: string
  working: boolean
  historyCount: number
  originUrl: string | null
  strokes: StrokeRecord[]
  fontContours: string[]
}

// 저장된 행(있으면)과 기본값을 합쳐 모든 레이어가 공통으로 갖는 표시 속성을 만든다.
function builtinBase(spec: BuiltinLayerSpec, saved: CharacterLayerRow | undefined, working: boolean) {
  const defaultName = spec.id === LAYER_ID.strokes && working ? '작업 획 (초안)' : spec.name
  return {
    id: spec.id,
    kind: spec.kind,
    name: saved?.name ? saved.name : defaultName,
    z_index: saved ? saved.z_index : spec.z_index,
    visible: saved ? Boolean(saved.visible) : spec.visible,
    opacity: saved ? clampOpacity(saved.opacity, spec.opacity) : spec.opacity,
    locked: isReferenceKind(spec.kind) ? true : (saved ? Boolean(saved.locked) : spec.locked),
    label_color: saved ? normalizeColor(saved.label_color, spec.label_color) : spec.label_color,
  }
}

// 기본 레이어 하나의 기록. fontPaths는 화면에 보이는 궁서체 윤곽(편집됐으면 그 윤곽)으로, OUTLINE 매핑이 가리키는 기준이다.
function builtinLayerRecord(
  db: DatabaseSync,
  spec: BuiltinLayerSpec,
  saved: CharacterLayerRow | undefined,
  params: LayerBuildParams,
  fontPaths: string[],
): LayerRecord {
  // 종류마다 달라지는 내용(획·윤곽·가용 여부 등)만 아래에서 채운다.
  const base = builtinBase(spec, saved, params.working)
  const modified = Boolean(saved?.modified)

  if (spec.kind === 'FONT') {
    const customPaths = saved?.modified && saved.paths_json ? parseStoredPaths(saved.paths_json) : null
    const customStrokes = saved?.modified && saved.strokes_json ? parseStoredStrokes(saved.strokes_json) : []
    const paths = customPaths ?? params.fontContours
    return { ...base, available: paths.length > 0 || customStrokes.length > 0, modified, source_url: null, strokes: customStrokes, paths }
  }

  if (spec.kind === 'OUTLINE') {
    const strokes = saved?.strokes_json ? parseStoredStrokes(saved.strokes_json) : []
    const currentHash = fontFingerprint(fontPaths)
    return {
      ...base,
      available: strokes.length > 0,
      modified,
      source_url: null,
      strokes,
      paths: [],
      stale: strokes.some((stroke) => stroke.font_hash !== undefined && stroke.font_hash !== currentHash),
    }
  }

  if (isReferenceKind(spec.kind)) {
    const ref = readCachedRefStrokes(db, params.unicode, spec.kind)
    const customStrokes = saved?.modified && saved.strokes_json ? parseStoredStrokes(saved.strokes_json) : null
    const strokes = customStrokes ?? ref.strokes
    return { ...base, available: strokes.length > 0, modified, source_url: ref.url, strokes, paths: [] }
  }

  if (spec.kind === 'STROKES') {
    return {
      ...base,
      available: params.strokes.length > 0,
      modified: params.historyCount > 0 || params.working,
      source_url: params.originUrl,
      strokes: params.strokes,
      paths: [],
    }
  }

  // MEDIANS / NUMBERS 오버레이 레이어
  return { ...base, available: true, modified: false, source_url: null, strokes: [], paths: [] }
}

function customLayerRecord(saved: CharacterLayerRow): LayerRecord {
  const strokes = saved.strokes_json ? parseStoredStrokes(saved.strokes_json) : []
  const paths = saved.paths_json ? parseStoredPaths(saved.paths_json) : []
  return {
    id: saved.layer_id,
    kind: 'CUSTOM',
    name: saved.name,
    z_index: saved.z_index,
    visible: Boolean(saved.visible),
    opacity: clampOpacity(saved.opacity, DEFAULT_CUSTOM_LAYER_OPACITY),
    locked: Boolean(saved.locked),
    label_color: normalizeColor(saved.label_color, 'none'),
    available: strokes.length > 0 || paths.length > 0,
    modified: Boolean(saved.modified),
    source_url: null,
    strokes,
    paths,
  }
}

export function buildCharacterLayers(db: DatabaseSync, params: LayerBuildParams): LayerRecord[] {
  const savedRows = db
    .prepare('SELECT * FROM character_layers WHERE char = ? ORDER BY z_index ASC')
    .all(params.char) as CharacterLayerRow[]
  const savedById = new Map(savedRows.map((row) => [row.layer_id, row]))

  const records: LayerRecord[] = []
  let fontPaths = params.fontContours
  for (const spec of BUILTIN_LAYERS) {
    const record = builtinLayerRecord(db, spec, savedById.get(spec.id), params, fontPaths)
    if (record.kind === 'FONT') fontPaths = record.paths
    records.push(record)
  }
  for (const saved of savedRows) {
    if (saved.kind === 'CUSTOM') records.push(customLayerRecord(saved))
  }
  return records.sort((a, b) => a.z_index - b.z_index)
}
