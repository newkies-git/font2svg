import type { ChatEdit, CapType } from '../../shared/types.ts'

const CAP_LABEL: Record<CapType, string> = {
  NONE: '없음',
  AUTO_ROUND: '자동 둥글림',
  POINTED: '뾰족',
  BULGE: '볼록',
  TAPER: '테이퍼',
  REF_STAMP: '참고 도장',
  MANUAL: '수동',
}

// 수정 제안을 사람이 읽는 문장으로 바꾼다.
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
