import { createHash } from 'node:crypto'
import { CAP_TYPES, OLLAMA_CHAT_MAX_EDITS } from '../shared/constants.ts'
import { isRecord } from '../shared/guards.ts'
import { moveItem, withCap } from '../shared/strokeOps.ts'
import type { CapType, ChatEdit, StrokeRecord } from '../shared/types.ts'
import { mergeTwoStrokes, reverseMedian } from '../shared/vectorEdit.ts'

const CAP_SET: ReadonlySet<string> = new Set(CAP_TYPES)
// 번호가 밀리는 수정. 한 번에 하나만 받아들여 번호가 어긋나는 일을 막는다.
const STRUCTURAL_OPS: ReadonlySet<string> = new Set(['move', 'delete', 'merge_next'])

// 제안을 받은 뒤 획 데이터가 바뀌었는지 가리는 지문의 길이(16진 문자 수)
const FINGERPRINT_LENGTH = 16

// 획 목록의 내용(윤곽·중심선·폭·부수·기필/수필)으로 만든 짧은 지문. 같은 내용이면 같고, 하나라도 다르면 달라진다.
export function strokesFingerprint(strokes: StrokeRecord[]): string {
  const content = strokes.map((s) => [s.outline_path, s.median_points, s.stroke_width, s.is_radical, s.start_cap_type, s.end_cap_type])
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, FINGERPRINT_LENGTH)
}

export const EDIT_OPS = ['set_radical', 'set_cap', 'reverse', 'move', 'delete', 'merge_next'] as const

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

// 모델이 낸 수정 제안 중 형식·범위가 맞는 것만 남긴다. 번호가 밀리는 수정은 하나만 받는다.
export function sanitizeEdits(raw: unknown, strokeCount: number): ChatEdit[] {
  if (!Array.isArray(raw)) return []
  const edits: ChatEdit[] = []
  let structural = false
  for (const item of raw) {
    if (edits.length >= OLLAMA_CHAT_MAX_EDITS) break
    if (!isRecord(item) || typeof item.op !== 'string') continue
    const stroke = finite(item.stroke)
    if (stroke === null || !Number.isInteger(stroke) || stroke < 1 || stroke > strokeCount) continue
    if (structural && STRUCTURAL_OPS.has(item.op)) continue
    switch (item.op) {
      case 'set_radical': {
        const value = Number(item.value)
        if (value === 0 || value === 1) edits.push({ op: 'set_radical', stroke, value })
        break
      }
      case 'set_cap': {
        const value = typeof item.value === 'string' && CAP_SET.has(item.value) ? (item.value as CapType) : null
        if (value && (item.end === 'start' || item.end === 'end')) edits.push({ op: 'set_cap', stroke, end: item.end, value })
        break
      }
      case 'reverse':
        edits.push({ op: 'reverse', stroke })
        break
      case 'move': {
        const delta = finite(item.delta)
        if (delta !== null && Number.isInteger(delta) && delta !== 0 && stroke + delta >= 1 && stroke + delta <= strokeCount) {
          edits.push({ op: 'move', stroke, delta })
          structural = true
        }
        break
      }
      case 'delete':
        if (strokeCount > 1) {
          edits.push({ op: 'delete', stroke })
          structural = true
        }
        break
      case 'merge_next':
        if (stroke < strokeCount) {
          edits.push({ op: 'merge_next', stroke })
          structural = true
        }
        break
      default:
        break
    }
  }
  return edits
}

// 검증된 수정을 획 목록에 적용한 새 목록. 번호가 밀리지 않는 수정을 먼저 적용하고, 적용할 수 없으면 던진다.
export function applyStrokeEdits(strokes: StrokeRecord[], edits: ChatEdit[]): StrokeRecord[] {
  let next = strokes.map((stroke) => ({ ...stroke }))
  const ordered = [...edits.filter((edit) => !STRUCTURAL_OPS.has(edit.op)), ...edits.filter((edit) => STRUCTURAL_OPS.has(edit.op))]
  for (const edit of ordered) {
    const index = edit.stroke - 1
    const target = next[index]
    if (!target) throw new Error(`${edit.stroke}획이 없습니다.`)
    switch (edit.op) {
      case 'set_radical':
        next[index] = { ...target, is_radical: edit.value }
        break
      case 'set_cap': {
        const capped = withCap(target, edit.end, edit.value)
        if (!capped) throw new Error(`${edit.stroke}획의 ${edit.end === 'start' ? '기필' : '수필'}에는 이 모양을 적용할 수 없습니다.`)
        next[index] = capped
        break
      }
      case 'reverse':
        next[index] = { ...target, median_points: reverseMedian(target.median_points) }
        break
      case 'move': {
        const moved = moveItem(next, index, edit.delta)
        if (!moved) throw new Error(`${edit.stroke}획을 이동할 수 없습니다.`)
        next = moved
        break
      }
      case 'delete':
        next = next.filter((_, i) => i !== index)
        break
      case 'merge_next': {
        if (!next[index + 1]) throw new Error(`${edit.stroke}획 다음 획이 없습니다.`)
        next.splice(index, 2, mergeTwoStrokes(target, next[index + 1]))
        break
      }
    }
  }
  return next.map((stroke, i) => ({ ...stroke, stroke_order: i + 1 }))
}
