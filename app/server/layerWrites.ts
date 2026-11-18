import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_CUSTOM_LAYER_OPACITY } from '../shared/constants.ts'
import type { LayerColor, LayerMetaPatch, LayerRecord } from '../shared/types.ts'
import { transaction } from './db.ts'
import { clampOpacity, normalizeColor, sanitizeLayerPaths, sanitizeLayerStrokes } from './layerData.ts'
import { isReferenceKind } from '../shared/layerKind.ts'
import { BUILTIN_LAYERS, type BuiltinLayerSpec } from './layers.ts'
import type { CharacterLayerRow } from './schema.ts'

// 표시 설정으로 저장하는 값. visible·locked는 DB에 0/1로 들어간다.
type LayerMeta = { kind: string; name: string; z_index: number; visible: number; opacity: number; locked: number; label_color: LayerColor }

// 지금 적용 중인 표시 설정: 저장된 행이 있으면 그 값, 없으면 기본 레이어의 값.
function currentLayerMeta(existing: CharacterLayerRow | undefined, builtin: BuiltinLayerSpec | undefined): LayerMeta | null {
  if (existing) {
    return {
      kind: existing.kind,
      name: existing.name,
      z_index: existing.z_index,
      visible: existing.visible,
      opacity: existing.opacity,
      locked: existing.locked,
      label_color: existing.label_color as LayerColor,
    }
  }
  if (!builtin) return null
  return {
    kind: builtin.kind,
    name: builtin.name,
    z_index: builtin.z_index,
    visible: builtin.visible ? 1 : 0,
    opacity: builtin.opacity,
    locked: builtin.locked ? 1 : 0,
    label_color: builtin.label_color,
  }
}

// 요청(patch)에서 올바른 타입으로 온 값만 현재 설정에 덮어쓴다. 잘못된 값은 현재 값을 유지한다.
export function mergeLayerMeta(current: LayerMeta, patch: LayerMetaPatch): LayerMeta {
  const name = typeof patch.name === 'string' ? patch.name.trim() : ''
  return {
    kind: current.kind,
    name: name || current.name,
    z_index: typeof patch.z_index === 'number' && Number.isFinite(patch.z_index) ? Math.round(patch.z_index) : current.z_index,
    visible: typeof patch.visible === 'boolean' ? Number(patch.visible) : current.visible,
    opacity: patch.opacity !== undefined ? clampOpacity(patch.opacity, current.opacity) : current.opacity,
    locked: isReferenceKind(current.kind) ? 1 : (typeof patch.locked === 'boolean' ? Number(patch.locked) : current.locked),
    label_color: patch.label_color !== undefined ? normalizeColor(patch.label_color, current.label_color) : current.label_color,
  }
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
      const current = currentLayerMeta(existing, builtinById.get(patch.id))
      if (!current) continue
      const next = mergeLayerMeta(current, patch)
      upsert.run(
        char,
        patch.id,
        next.kind,
        next.name,
        next.z_index,
        next.visible,
        next.opacity,
        next.locked,
        next.label_color,
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
  const current = currentLayerMeta(existing, builtin)
  if (!current) throw new Error('존재하지 않는 레이어입니다.')
  if (isReferenceKind(current.kind)) {
    throw new Error('참고 레이어(네이버·AnimCJK·Hanzi)는 편집하지 않습니다. 작업 획으로 가져온 뒤 고치세요.')
  }
  if (current.kind === 'MEDIANS' || current.kind === 'NUMBERS') {
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
    current.kind,
    current.name,
    current.z_index,
    current.visible,
    current.opacity,
    current.locked,
    current.label_color,
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
    VALUES (?, ?, 'CUSTOM', ?, ?, 1, ?, 0, ?, ?, ?, 1)
  `).run(char, id, name, maxZ + 1, DEFAULT_CUSTOM_LAYER_OPACITY, color, strokesJson, pathsJson)
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
