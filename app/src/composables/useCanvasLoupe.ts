import { computed, ref } from 'vue'
import { CANVAS } from '../../shared/constants.ts'
import type { EditorTool, Pt } from '../../shared/types.ts'

const LOUPE_ZOOM = 2.8
const LOUPE_RADIUS = 58
const LOUPE_OFFSET = 78
// 돋보기가 캔버스 가장자리에서 떨어지는 여백과, 커서에서 우상단으로 비켜 놓는 비율
const LOUPE_EDGE_MARGIN = 4
const LOUPE_OFFSET_X_RATIO = 0.55
const LOUPE_OFFSET_Y_RATIO = 0.75

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
    const lowest = LOUPE_RADIUS + LOUPE_EDGE_MARGIN
    const highest = CANVAS - lowest
    const cx = Math.min(highest, Math.max(lowest, s.x + LOUPE_OFFSET * LOUPE_OFFSET_X_RATIO))
    const cy = Math.min(highest, Math.max(lowest, s.y - LOUPE_OFFSET * LOUPE_OFFSET_Y_RATIO))
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
