import type { CapType, ChatContext, ChatEdit, LayerRecord, StrokeRecord } from '../../shared/types.ts'

// 채팅 모델이 제안한 수정을 실제로 적용하는 동작 모음(획 번호는 0부터).
export type ChatEditActions = {
  setRadical: (index: number, value: 0 | 1) => void
  setCap: (index: number, end: 'start' | 'end', value: CapType) => void
  reverse: (index: number) => void
  move: (index: number, delta: number) => void
  remove: (index: number) => void
  mergeNext: (index: number) => void
}

const STRUCTURAL_OPS: ReadonlySet<ChatEdit['op']> = new Set(['move', 'delete', 'merge_next'])
const CAP_LABEL: Record<CapType, string> = {
  NONE: '없음',
  AUTO_ROUND: '자동 둥글림',
  POINTED: '뾰족',
  BULGE: '볼록',
  TAPER: '테이퍼',
  REF_STAMP: '참고 도장',
  MANUAL: '수동',
}

export function describeEdit(edit: ChatEdit): string {
  switch (edit.op) {
    case 'set_radical':
      return `${edit.stroke}획 부수 ${edit.value ? '지정' : '해제'}`
    case 'set_cap':
      return `${edit.stroke}획 ${edit.end === 'start' ? '기필' : '수필'} 모양: ${CAP_LABEL[edit.value]}`
    case 'reverse':
      return `${edit.stroke}획 중심선 방향 반전`
    case 'move':
      return `${edit.stroke}획을 ${edit.delta > 0 ? '뒤로' : '앞으로'} ${Math.abs(edit.delta)}칸 이동`
    case 'delete':
      return `${edit.stroke}획 삭제`
    case 'merge_next':
      return `${edit.stroke}획과 ${edit.stroke + 1}획 병합`
  }
}

// 번호가 밀리지 않는 수정을 먼저, 번호가 밀리는 수정은 뒤에 적용한다.
export function applyChatEdits(edits: ChatEdit[], actions: ChatEditActions): void {
  const ordered = [...edits.filter((edit) => !STRUCTURAL_OPS.has(edit.op)), ...edits.filter((edit) => STRUCTURAL_OPS.has(edit.op))]
  for (const edit of ordered) {
    const index = edit.stroke - 1
    switch (edit.op) {
      case 'set_radical':
        actions.setRadical(index, edit.value)
        break
      case 'set_cap':
        actions.setCap(index, edit.end, edit.value)
        break
      case 'reverse':
        actions.reverse(index)
        break
      case 'move':
        actions.move(index, edit.delta)
        break
      case 'delete':
        actions.remove(index)
        break
      case 'merge_next':
        actions.mergeNext(index)
        break
    }
  }
}

// 모델에게 알려줄 현재 글자·레이어 요약.
export function buildChatContext(
  selected: { char: string; reading?: string | null; meaning?: string | null } | null,
  layer: Pick<LayerRecord, 'name' | 'strokes'> | null,
): ChatContext | undefined {
  if (!selected) return undefined
  const strokes = (layer?.strokes ?? []).map((stroke: StrokeRecord, index) => {
    const points = stroke.median_points
    const first = points[0] ?? [0, 0]
    const last = points[points.length - 1] ?? [0, 0]
    return {
      order: index + 1,
      points: points.length,
      width: stroke.stroke_width,
      is_radical: stroke.is_radical,
      start_cap: stroke.start_cap_type,
      end_cap: stroke.end_cap_type,
      start: first,
      end: last,
    }
  })
  return {
    char: selected.char,
    reading: selected.reading ?? undefined,
    meaning: selected.meaning ?? undefined,
    layerName: layer?.name ?? '',
    strokes,
  }
}
