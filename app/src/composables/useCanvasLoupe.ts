import { computed, ref } from 'vue'
import { CANVAS } from '../lib/constants.ts'
import type { EditorTool, Pt } from '../types.ts'

const LOUPE_ZOOM = 2.8
const LOUPE_RADIUS = 58
const LOUPE_OFFSET = 78

export function useCanvasLoupe(
  tool: () => EditorTool,
  fontToScreen: (pt: Pt) => { x: number; y: number },
  eventToFont: (event: PointerEvent | MouseEvent) => Pt | null,
) {
  const loupeVisible = ref(false)
  const loupeFont = ref<Pt | null>(null)

  const loupeEnabled = computed(
    () => tool() === 'bezier' || tool() === 'median' || tool() === 'knife' || tool() === 'connect',
  )

  const loupeScreen = computed(() => {
    const pt = loupeFont.value
    if (!pt) return null
    return fontToScreen(pt)
  })

  const loupeLens = computed(() => {
    const s = loupeScreen.value
    if (!s) return null
    // 커서를 가리지 않도록 우상단으로 오프셋
    const cx = Math.min(CANVAS - LOUPE_RADIUS - 4, Math.max(LOUPE_RADIUS + 4, s.x + LOUPE_OFFSET * 0.55))
    const cy = Math.min(CANVAS - LOUPE_RADIUS - 4, Math.max(LOUPE_RADIUS + 4, s.y - LOUPE_OFFSET * 0.75))
    return { cx, cy, sx: s.x, sy: s.y }
  })

  function onCanvasPointerMove(event: PointerEvent) {
    if (!loupeEnabled.value) {
      loupeVisible.value = false
      return
    }
    const pt = eventToFont(event)
    if (!pt) {
      loupeVisible.value = false
      return
    }
    loupeFont.value = pt
    loupeVisible.value = true
  }

  function onCanvasPointerLeave() {
    loupeVisible.value = false
  }

  return {
    loupeVisible,
    loupeEnabled,
    loupeLens,
    LOUPE_ZOOM,
    LOUPE_RADIUS,
    onCanvasPointerMove,
    onCanvasPointerLeave,
  }
}
