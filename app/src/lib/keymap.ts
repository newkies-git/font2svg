import type { EditorTool } from '../../shared/types.ts'
import { NUDGE_STEP } from '../../shared/constants.ts'

// 전역 단축키를 "무슨 동작인지"로 해석한다(순수 함수). 동작 실행과 입력창·선택 글자 검사는 App.vue가 맡는다.
export type KeyAction =
  | { type: 'save' }
  | { type: 'undo' }
  | { type: 'tool'; tool: EditorTool }
  | { type: 'commitConnect' }
  | { type: 'undoConnectPoint' }
  | { type: 'deletePathPoints' }
  | { type: 'nudge'; dx: number; dy: number }
  | { type: 'stepPrev' }
  | { type: 'stepNext' }
  | { type: 'togglePlay' }
  | { type: 'cancel' }

export type KeyContext = {
  key: string
  meta: boolean
  ctrl: boolean
  alt: boolean
  shift: boolean
  activeTool: EditorTool
  // 선택 도구이고 편집 가능한 상태일 때만 Shift+방향키로 획을 옮길 수 있다.
  canNudge: boolean
}

const TOOL_KEYS: Record<string, EditorTool> = { v: 'select', a: 'bezier', m: 'median', k: 'knife', p: 'connect' }
// 방향키 → 이동 방향. 저장 좌표는 y가 위쪽으로 늘어난다.
const NUDGE_DIRECTIONS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
}

// 처리하지 않는 키면 null. null이 아니면 호출한 쪽이 'cancel'을 뺀 모든 동작에서 기본 동작을 막는다.
export function resolveKeyAction(context: KeyContext): KeyAction | null {
  const { key, activeTool } = context
  const lower = key.toLowerCase()
  if ((context.meta || context.ctrl) && !context.alt) {
    if (lower === 's') return { type: 'save' }
    if (lower === 'z' && !context.shift) return { type: 'undo' }
    return null
  }
  if (context.alt) return null

  const tool = TOOL_KEYS[lower]
  if (tool) return { type: 'tool', tool }

  if (activeTool === 'connect') {
    if (key === 'Enter') return { type: 'commitConnect' }
    if (key === 'Backspace') return { type: 'undoConnectPoint' }
  }

  if (activeTool === 'bezier' && (key === 'Backspace' || key === 'Delete')) {
    return { type: 'deletePathPoints' }
  }

  const direction = NUDGE_DIRECTIONS[key]
  if (direction && context.shift && (activeTool === 'select' || activeTool === 'bezier') && context.canNudge) {
    return { type: 'nudge', dx: direction[0] * NUDGE_STEP, dy: direction[1] * NUDGE_STEP }
  }

  if (key === 'ArrowLeft') return { type: 'stepPrev' }
  if (key === 'ArrowRight') return { type: 'stepNext' }
  if (key === ' ') return { type: 'togglePlay' }
  if (key === 'Escape') return { type: 'cancel' }
  return null
}
