import { LAYER_BATCH_LIMIT } from '../shared/constants.ts'
import type { Pt } from '../shared/types.ts'
import { roundPoints } from './geometry.ts'

export type LayerSavePayload = { strokes?: unknown; paths?: unknown; action?: string }

// 레이어 저장 요청 한 건의 내용만 골라 정리한다. action은 문자열일 때만 받는다.
export function parseLayerSavePayload(raw: { strokes?: unknown; paths?: unknown; action?: unknown }): LayerSavePayload {
  return { strokes: raw.strokes, paths: raw.paths, action: typeof raw.action === 'string' ? raw.action : undefined }
}

// 여러 레이어 저장 요청을 검사해 id와 내용으로 정리한다. 비었거나 너무 많거나 id가 없거나 겹치면 던진다.
export function parseLayerBatch(items: unknown): { id: string; payload: LayerSavePayload }[] {
  if (!Array.isArray(items) || items.length === 0) throw new Error('저장할 레이어 목록이 비어 있습니다.')
  if (items.length > LAYER_BATCH_LIMIT) throw new Error(`한 번에 저장할 수 있는 레이어는 ${LAYER_BATCH_LIMIT}개까지입니다.`)
  const ids = new Set<string>()
  return items.map((item, index) => {
    const entry = (item ?? {}) as { id?: unknown; strokes?: unknown; paths?: unknown; action?: unknown }
    if (typeof entry.id !== 'string' || !entry.id) throw new Error(`${index + 1}번째 레이어에 id가 없습니다.`)
    if (ids.has(entry.id)) throw new Error(`레이어 '${entry.id}'가 중복되었습니다.`)
    ids.add(entry.id)
    return { id: entry.id, payload: parseLayerSavePayload(entry) }
  })
}

// 재분할 요청의 중심선 배열을 검사해 반올림한 중심선 목록으로 돌려준다.
export function parseResegmentMedians(raw: unknown): Pt[][] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('중심선 배열이 비어 있습니다.')
  return raw.map((line, index) => {
    if (!Array.isArray(line) || line.length < 2) throw new Error(`${index + 1}획 중심선은 2점 이상이어야 합니다.`)
    return roundPoints(line as Pt[])
  })
}
