import { ref } from 'vue'
import type { CharacterDetail } from '../types.ts'

// 화면 전체가 공유하는 상태: 선택한 글자, 상태·오류 메시지, 진행 중 표시, 재생 위치.
// 컴포저블마다 이 값들을 낱개 인자로 받던 것을 한 객체로 묶어 넘긴다.
export function useStudioState() {
  return {
    selected: ref<CharacterDetail | null>(null),
    message: ref('편집할 한자를 좌측 목록에서 선택하세요.'),
    error: ref(''),
    busy: ref(false),
    shown: ref(0),
    reveal: ref(1),
  }
}

export type StudioState = ReturnType<typeof useStudioState>
