import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_STROKE_WIDTH, FONT_FINGERPRINT_LENGTH, MIN_STROKE_WIDTH, OPACITY_STEPS, STROKE_WIDTH_CAP_RATIO, LAYER_ID } from '../src/lib/constants.ts'
import { warnOnce } from '../src/lib/log.ts'
import { isReferenceKind, type ReferenceKind } from '../src/lib/layerKind.ts'
import { isValidSvgPath } from '../src/lib/paths.ts'
import type { LayerColor, LayerKind, LayerMetaPatch, LayerRecord, Pt, StrokeRecord } from '../src/types.ts'
import { transaction } from './db.ts'
import { ribbonPath, roundPoints } from './geometry.ts'
import { normalizeCap } from './model.ts'
import { hanjaStrokes, parseHanja } from './references.ts'
import type { CharacterLayerRow } from './schema.ts'

type BuiltinLayerSpec = {
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

const FONT_HASH_RE = /^[0-9a-f]+$/
const VALID_COLORS = new Set<LayerColor>(['none', 'ink', 'slate', 'blue', 'violet', 'green', 'amber', 'rose'])

function clampStrokeWidth(value: number): number {
  const max = Math.round(DEFAULT_STROKE_WIDTH * STROKE_WIDTH_CAP_RATIO)
  return Math.max(MIN_STROKE_WIDTH, Math.min(max, Math.round(value) || DEFAULT_STROKE_WIDTH))
}

function clampOpacity(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(0, Math.min(1, Math.round(n * OPACITY_STEPS) / OPACITY_STEPS))
}

function normalizeColor(value: unknown, fallback: LayerColor): LayerColor {
  return typeof value === 'string' && VALID_COLORS.has(value as LayerColor) ? (value as LayerColor) : fallback
}

export function sanitizeLayerStrokes(raw: unknown): StrokeRecord[] {
  if (!Array.isArray(raw)) throw new Error('획 목록 형식이 올바르지 않습니다.')
  return raw.map((item, index) => {
    const stroke = item as Partial<StrokeRecord>
    if (!Array.isArray(stroke.median_points) || stroke.median_points.length < 2) {
      throw new Error(`${index + 1}획의 중심선은 2점 이상이어야 합니다.`)
    }
    const median = roundPoints(stroke.median_points as Pt[])
    const outline = typeof stroke.outline_path === 'string' && stroke.outline_path.trim()
      ? stroke.outline_path.trim()
      : ribbonPath(median, stroke.stroke_width ?? DEFAULT_STROKE_WIDTH)
    if (!isValidSvgPath(outline)) {
      throw new Error(`${index + 1}획의 SVG 외곽선 경로가 올바르지 않습니다.`)
    }
    const record: StrokeRecord = {
      stroke_order: index + 1,
      outline_path: outline,
      median_points: median,
      stroke_width: clampStrokeWidth(Number(stroke.stroke_width ?? DEFAULT_STROKE_WIDTH)),
      is_radical: stroke.is_radical ? 1 : 0,
      start_cap_type: normalizeCap(stroke.start_cap_type),
      end_cap_type: normalizeCap(stroke.end_cap_type),
    }
    if (Array.isArray(stroke.font_contours)) {
      record.font_contours = [...new Set(stroke.font_contours.filter((i) => Number.isInteger(i) && i >= 0))].sort((a, b) => a - b)
      record.map_manual = stroke.map_manual ? 1 : 0
      if (typeof stroke.font_hash === 'string' && FONT_HASH_RE.test(stroke.font_hash)) record.font_hash = stroke.font_hash
    }
    return record
  })
}

export function sanitizeLayerPaths(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error('윤곽 경로 목록 형식이 올바르지 않습니다.')
  return raw.map((entry, index) => {
    const path = String(entry ?? '').trim()
    if (!isValidSvgPath(path)) throw new Error(`${index + 1}번째 윤곽 경로가 올바르지 않습니다.`)
    return path
  })
}

// character_layers에 저장된 JSON을 읽는 유일한 지점. 형식이 어긋난 값(손상·이전 버전)은 화면 전체를 깨뜨리지 않도록
// 경고만 남기고 해당 레이어를 비운다. 획은 최소한 윤곽 문자열과 중심선 배열이 있어야 한다.
function parseStoredJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text)
  } catch (error) {
    warnOnce(`layers-${label}`, error)
    return null
  }
}

function isStoredStroke(value: unknown): value is StrokeRecord {
  if (typeof value !== 'object' || value === null) return false
  const stroke = value as Partial<StrokeRecord>
  return typeof stroke.outline_path === 'string' && Array.isArray(stroke.median_points)
}

export function parseStoredStrokes(text: string): StrokeRecord[] {
  const value = parseStoredJson(text, 'strokes')
  if (Array.isArray(value) && value.every(isStoredStroke)) return value
  if (value !== null) warnOnce('layers-strokes', new Error('저장된 레이어 획 형식이 올바르지 않습니다.'))
  return []
}

export function parseStoredPaths(text: string): string[] {
  const value = parseStoredJson(text, 'paths')
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) return value
  if (value !== null) warnOnce('layers-paths', new Error('저장된 레이어 윤곽 형식이 올바르지 않습니다.'))
  return []
}

function readCachedRefStrokes(
  db: DatabaseSync,
  unicode: string,
  source: ReferenceKind,
): { strokes: StrokeRecord[]; url: string | null } {
  const row = db
    .prepare('SELECT found, raw_data, source_url FROM reference_data WHERE unicode = ? AND source = ?')
    .get(unicode, source) as { found: number; raw_data: string | null; source_url: string | null } | undefined
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

export function buildCharacterLayers(
  db: DatabaseSync,
  params: {
    unicode: string
    char: string
    working: boolean
    historyCount: number
    originUrl: string | null
    strokes: StrokeRecord[]
    fontContours: string[]
  },
): LayerRecord[] {
  const savedRows = db
    .prepare('SELECT * FROM character_layers WHERE char = ? ORDER BY z_index ASC')
    .all(params.char) as CharacterLayerRow[]
  const savedById = new Map(savedRows.map((row) => [row.layer_id, row]))

  const records: LayerRecord[] = []
  // 화면에 보이는 궁서체 윤곽(편집됐으면 그 윤곽). OUTLINE 매핑이 가리키는 기준이다.
  let fontPaths = params.fontContours

  for (const spec of BUILTIN_LAYERS) {
    const saved = savedById.get(spec.id)
    const visible = saved ? Boolean(saved.visible) : spec.visible
    const opacity = saved ? clampOpacity(saved.opacity, spec.opacity) : spec.opacity
    const locked = saved ? Boolean(saved.locked) : spec.locked
    const zIndex = saved ? saved.z_index : spec.z_index
    const labelColor = saved ? normalizeColor(saved.label_color, spec.label_color) : spec.label_color
    const defaultName = spec.id === LAYER_ID.strokes && params.working ? '작업 획 (초안)' : spec.name
    const name = saved?.name ? saved.name : defaultName

    if (spec.kind === 'FONT') {
      const customPaths = saved?.modified && saved.paths_json ? parseStoredPaths(saved.paths_json) : null
      const customStrokes = saved?.modified && saved.strokes_json ? parseStoredStrokes(saved.strokes_json) : []
      const paths = customPaths ?? params.fontContours
      fontPaths = paths
      records.push({
        id: spec.id,
        kind: spec.kind,
        name,
        z_index: zIndex,
        visible,
        opacity,
        locked,
        label_color: labelColor,
        available: paths.length > 0 || customStrokes.length > 0,
        modified: Boolean(saved?.modified),
        source_url: null,
        strokes: customStrokes,
        paths,
      })
      continue
    }

    if (spec.kind === 'OUTLINE') {
      const strokes = saved?.strokes_json ? parseStoredStrokes(saved.strokes_json) : []
      const currentHash = fontFingerprint(fontPaths)
      records.push({
        id: spec.id,
        kind: spec.kind,
        name,
        z_index: zIndex,
        visible,
        opacity,
        locked,
        label_color: labelColor,
        available: strokes.length > 0,
        modified: Boolean(saved?.modified),
        source_url: null,
        strokes,
        paths: [],
        stale: strokes.some((stroke) => stroke.font_hash !== undefined && stroke.font_hash !== currentHash),
      })
      continue
    }

    if (isReferenceKind(spec.kind)) {
      const ref = readCachedRefStrokes(db, params.unicode, spec.kind)
      const customStrokes = saved?.modified && saved.strokes_json ? parseStoredStrokes(saved.strokes_json) : null
      const strokes = customStrokes ?? ref.strokes
      records.push({
        id: spec.id,
        kind: spec.kind,
        name,
        z_index: zIndex,
        visible,
        opacity,
        locked,
        label_color: labelColor,
        available: strokes.length > 0,
        modified: Boolean(saved?.modified),
        source_url: ref.url,
        strokes,
        paths: [],
      })
      continue
    }

    if (spec.kind === 'STROKES') {
      records.push({
        id: spec.id,
        kind: spec.kind,
        name,
        z_index: zIndex,
        visible,
        opacity,
        locked,
        label_color: labelColor,
        available: params.strokes.length > 0,
        modified: params.historyCount > 0 || params.working,
        source_url: params.originUrl,
        strokes: params.strokes,
        paths: [],
      })
      continue
    }

    // MEDIANS / NUMBERS 오버레이 레이어
    records.push({
      id: spec.id,
      kind: spec.kind,
      name,
      z_index: zIndex,
      visible,
      opacity,
      locked,
      label_color: labelColor,
      available: true,
      modified: false,
      source_url: null,
      strokes: [],
      paths: [],
    })
  }

  for (const saved of savedRows) {
    if (saved.kind !== 'CUSTOM') continue
    const strokes = saved.strokes_json ? parseStoredStrokes(saved.strokes_json) : []
    const paths = saved.paths_json ? parseStoredPaths(saved.paths_json) : []
    records.push({
      id: saved.layer_id,
      kind: 'CUSTOM',
      name: saved.name,
      z_index: saved.z_index,
      visible: Boolean(saved.visible),
      opacity: clampOpacity(saved.opacity, 0.85),
      locked: Boolean(saved.locked),
      label_color: normalizeColor(saved.label_color, 'none'),
      available: strokes.length > 0 || paths.length > 0,
      modified: Boolean(saved.modified),
      source_url: null,
      strokes,
      paths,
    })
  }

  return records.sort((a, b) => a.z_index - b.z_index)
}

export function patchLayersMeta(db: DatabaseSync, char: string, patches: LayerMetaPatch[]): void {
  const builtinById = new Map(BUILTIN_LAYERS.map((b) => [b.id, b]))
  const selectOne = db.prepare('SELECT * FROM character_layers WHERE char = ? AND layer_id = ?')
  const upsert = db.prepare(`
    INSERT INTO character_layers (char, layer_id, kind, name, z_index, visible, opacity, locked, label_color, strokes_json, paths_json, modified, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(char, layer_id) DO UPDATE SET
      name = excluded.name,
      z_index = excluded.z_index,
      visible = excluded.visible,
      opacity = excluded.opacity,
      locked = excluded.locked,
      label_color = excluded.label_color,
      updated_at = CURRENT_TIMESTAMP
  `)

  transaction(db, () => {
    for (const patch of patches) {
      if (!patch || typeof patch.id !== 'string') continue
      const existing = selectOne.get(char, patch.id) as CharacterLayerRow | undefined
      const builtin = builtinById.get(patch.id)
      if (!existing && !builtin) continue

      const kind = existing?.kind ?? builtin!.kind
      const baseName = existing?.name ?? builtin!.name
      const nextName = typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim() : baseName
      const nextZ = typeof patch.z_index === 'number' && Number.isFinite(patch.z_index)
        ? Math.round(patch.z_index)
        : (existing?.z_index ?? builtin!.z_index)
      const nextVisible = typeof patch.visible === 'boolean'
        ? (patch.visible ? 1 : 0)
        : (existing?.visible ?? (builtin!.visible ? 1 : 0))
      const nextOpacity = patch.opacity !== undefined
        ? clampOpacity(patch.opacity, existing?.opacity ?? builtin!.opacity)
        : (existing?.opacity ?? builtin!.opacity)
      const nextLocked = typeof patch.locked === 'boolean'
        ? (patch.locked ? 1 : 0)
        : (existing?.locked ?? (builtin!.locked ? 1 : 0))
      const nextColor = patch.label_color !== undefined
        ? normalizeColor(patch.label_color, (existing?.label_color as LayerColor) ?? builtin!.label_color)
        : ((existing?.label_color as LayerColor) ?? builtin!.label_color)

      upsert.run(
        char,
        patch.id,
        kind,
        nextName,
        nextZ,
        nextVisible,
        nextOpacity,
        nextLocked,
        nextColor,
        existing?.strokes_json ?? null,
        existing?.paths_json ?? null,
        existing?.modified ?? 0,
      )
    }
  })
}

// 레이어가 잠겨 있으면 내용 저장을 거부한다(화면 밖에서 온 요청도 같은 규칙을 따른다). 저장된 행이 없으면 기본 잠금 상태를 따른다.
// 외부 수신·원본 복원·작업 획 적용·윤곽 매핑은 레이어 내용을 직접 저장하는 경로가 아니므로 이 검사를 거치지 않는다.
export function assertLayerUnlocked(db: DatabaseSync, char: string, layerId: string): void {
  const row = db
    .prepare('SELECT locked FROM character_layers WHERE char = ? AND layer_id = ?')
    .get(char, layerId) as { locked: number } | undefined
  const locked = row ? Boolean(row.locked) : (BUILTIN_LAYERS.find((spec) => spec.id === layerId)?.locked ?? false)
  if (locked) throw new Error('잠긴 레이어는 저장할 수 없습니다. 잠금을 해제한 뒤 저장하세요.')
}

export function saveNonStrokeLayerContent(
  db: DatabaseSync,
  char: string,
  layerId: string,
  payload: { strokes?: unknown; paths?: unknown },
): void {
  const builtin = BUILTIN_LAYERS.find((b) => b.id === layerId)
  const existing = db
    .prepare('SELECT * FROM character_layers WHERE char = ? AND layer_id = ?')
    .get(char, layerId) as CharacterLayerRow | undefined
  if (!builtin && !existing) throw new Error('존재하지 않는 레이어입니다.')
  const kind = (existing?.kind ?? builtin!.kind) as LayerKind
  if (kind === 'MEDIANS' || kind === 'NUMBERS') {
    throw new Error('오버레이 레이어는 직접 도형을 저장하지 않습니다.')
  }

  const strokesJson = payload.strokes !== undefined
    ? JSON.stringify(sanitizeLayerStrokes(payload.strokes))
    : (existing?.strokes_json ?? null)
  const pathsJson = payload.paths !== undefined
    ? JSON.stringify(sanitizeLayerPaths(payload.paths))
    : (existing?.paths_json ?? null)

  db.prepare(`
    INSERT INTO character_layers (char, layer_id, kind, name, z_index, visible, opacity, locked, label_color, strokes_json, paths_json, modified, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(char, layer_id) DO UPDATE SET
      strokes_json = excluded.strokes_json,
      paths_json = excluded.paths_json,
      modified = 1,
      updated_at = CURRENT_TIMESTAMP
  `).run(
    char,
    layerId,
    kind,
    existing?.name ?? builtin!.name,
    existing?.z_index ?? builtin!.z_index,
    existing?.visible ?? (builtin!.visible ? 1 : 0),
    existing?.opacity ?? builtin!.opacity,
    existing?.locked ?? 0,
    existing?.label_color ?? builtin!.label_color,
    strokesJson,
    pathsJson,
  )
}

export function resetNonStrokeLayer(db: DatabaseSync, char: string, layerId: string): void {
  const builtin = BUILTIN_LAYERS.find((b) => b.id === layerId)
  if (!builtin || builtin.kind === 'STROKES' || builtin.kind === 'MEDIANS' || builtin.kind === 'NUMBERS') {
    throw new Error('원본으로 초기화할 수 있는 레퍼런스/폰트 레이어가 아닙니다.')
  }
  db.prepare(`
    UPDATE character_layers
    SET strokes_json = NULL, paths_json = NULL, modified = 0, updated_at = CURRENT_TIMESTAMP
    WHERE char = ? AND layer_id = ?
  `).run(char, layerId)
}

export function createCustomLayer(
  db: DatabaseSync,
  char: string,
  allLayers: LayerRecord[],
  sourceLayerId?: string,
  customName?: string,
): string {
  const source = sourceLayerId ? allLayers.find((l) => l.id === sourceLayerId) : undefined
  const maxZ = allLayers.reduce((max, l) => Math.max(max, l.z_index), 0)
  const id = `custom-${randomUUID().slice(0, 8)}`
  const name = customName?.trim() || (source ? `${source.name} 사본` : '새 레이어')
  const strokesJson = source && source.strokes.length > 0 ? JSON.stringify(source.strokes) : '[]'
  const pathsJson = source && source.paths.length > 0 ? JSON.stringify(source.paths) : '[]'
  const color: LayerColor = source?.label_color && source.label_color !== 'ink' ? source.label_color : 'blue'

  db.prepare(`
    INSERT INTO character_layers (char, layer_id, kind, name, z_index, visible, opacity, locked, label_color, strokes_json, paths_json, modified)
    VALUES (?, ?, 'CUSTOM', ?, ?, 1, 0.85, 0, ?, ?, ?, 1)
  `).run(char, id, name, maxZ + 1, color, strokesJson, pathsJson)
  return id
}

export function deleteCustomLayer(db: DatabaseSync, char: string, layerId: string): void {
  const row = db
    .prepare('SELECT kind FROM character_layers WHERE char = ? AND layer_id = ?')
    .get(char, layerId) as { kind: string } | undefined
  if (!row || row.kind !== 'CUSTOM') {
    throw new Error('기본 시스템 레이어는 삭제할 수 없습니다. 눈 아이콘으로 숨기거나 초기화하세요.')
  }
  db.prepare('DELETE FROM character_layers WHERE char = ? AND layer_id = ?').run(char, layerId)
}
