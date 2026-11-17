import { onBeforeUnmount, onMounted, type Ref } from 'vue'
import type { CharacterDetail, EditorTool, Pt } from '../../shared/types.ts'
import { resolveKeyAction } from '../lib/keymap.ts'

const TEXT_INPUT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

// 단축키가 실행하는 동작과 그 판단에 필요한 상태. 키 해석 자체는 resolveKeyAction(순수 함수)이 맡는다.
export type StudioShortcutDeps = {
  selected: Ref<CharacterDetail | null>
  busy: Ref<boolean>
  activeTool: Ref<EditorTool>
  isEditableLocked: Ref<boolean>
  playing: Ref<boolean>
  hasKnifePoints: () => boolean
  hasConnectPoints: () => boolean
  save: () => void
  undo: () => void
  selectTool: (tool: EditorTool) => void
  commitConnect: () => void
  undoConnectPoint: () => void
  nudge: (move: (x: number, y: number) => Pt) => void
  stepPrev: () => void
  stepNext: () => void
  play: () => void
  stop: () => void
  cancelKnife: () => void
  cancelConnect: () => void
}

export function useStudioShortcuts(deps: StudioShortcutDeps) {
  function onKeyDown(event: KeyboardEvent) {
    const tag = (event.target as HTMLElement)?.tagName
    if (TEXT_INPUT_TAGS.has(tag)) return
    const { selected } = deps
    if (!selected.value) return

    const action = resolveKeyAction({
      key: event.key,
      meta: event.metaKey,
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      activeTool: deps.activeTool.value,
      canNudge: !deps.isEditableLocked.value,
    })
    if (!action) return
    // Esc는 브라우저 기본 동작(전체화면 해제 등)을 그대로 둔다.
    if (action.type !== 'cancel') event.preventDefault()

    switch (action.type) {
      case 'save':
        if (!deps.busy.value) deps.save()
        break
      case 'undo':
        if (!deps.busy.value && selected.value.history_count > 0) deps.undo()
        break
      case 'tool':
        deps.selectTool(action.tool)
        break
      case 'commitConnect':
        deps.commitConnect()
        break
      case 'undoConnectPoint':
        deps.undoConnectPoint()
        break
      case 'nudge':
        deps.nudge((x, y) => [x + action.dx, y + action.dy])
        break
      case 'stepPrev':
        deps.stepPrev()
        break
      case 'stepNext':
        deps.stepNext()
        break
      case 'togglePlay':
        if (deps.playing.value) deps.stop()
        else deps.play()
        break
      case 'cancel':
        if (deps.hasKnifePoints()) deps.cancelKnife()
        else if (deps.hasConnectPoints()) deps.cancelConnect()
        break
    }
  }

  onMounted(() => window.addEventListener('keydown', onKeyDown))
  onBeforeUnmount(() => window.removeEventListener('keydown', onKeyDown))

  return { onKeyDown }
}
