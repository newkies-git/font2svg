import { computed, ref } from 'vue'
import { CANVAS } from '../../shared/constants.ts'
import type { EditorTool, Pt } from '../../shared/types.ts'

export const LOUPE_RADIUS = 108
const LOUPE_ZOOM_MIN = 2
const LOUPE_ZOOM_MAX = 8
const LOUPE_ZOOM_STEP = 0.5
const LOUPE_GAP = 36
const LOUPE_MARGIN = 8
// 렌즈 테두리와 커서 사이에 이만큼은 비워 둔다.
const LOUPE_CLEAR = 16

const LOUPE_TOOLS = new Set<EditorTool>(['bezier', 'median', 'knife', 'connect'])

const loupeOn = ref(true)
const loupeZoom = ref(4)

export function isLoupeTool(tool: EditorTool): boolean {
  return LOUPE_TOOLS.has(tool)
}

export function formatLoupeZoom(zoom: number): string {
  return Number.isInteger(zoom) ? String(zoom) : zoom.toFixed(1)
}

export function nextLoupeZoom(current: number, deltaY: number): number {
  const step = deltaY > 0 ? -LOUPE_ZOOM_STEP : LOUPE_ZOOM_STEP
  const next = Math.round((current + step) / LOUPE_ZOOM_STEP) * LOUPE_ZOOM_STEP
  return Math.min(LOUPE_ZOOM_MAX, Math.max(LOUPE_ZOOM_MIN, next))
}

function lensFits(cx: number, cy: number, canvas: number): boolean {
  return cx - LOUPE_RADIUS >= LOUPE_MARGIN
    && cy - LOUPE_RADIUS >= LOUPE_MARGIN
    && cx + LOUPE_RADIUS <= canvas - LOUPE_MARGIN
    && cy + LOUPE_RADIUS <= canvas - LOUPE_MARGIN
}

function clearsCursor(cx: number, cy: number, sx: number, sy: number): boolean {
  return Math.hypot(cx - sx, cy - sy) >= LOUPE_RADIUS + LOUPE_CLEAR
}

// 커서를 가리지 않는 자리. 오른쪽 위를 먼저 보고, 캔버스를 벗어나면 다른 대각으로 넘긴다.
export function placeLoupe(sx: number, sy: number, canvas = CANVAS): { cx: number; cy: number } {
  const reach = LOUPE_RADIUS + LOUPE_GAP
  const spots: Array<[number, number]> = [
    [sx + reach, sy - reach],
    [sx - reach, sy - reach],
    [sx + reach, sy + reach],
    [sx - reach, sy + reach],
  ]
  for (const [cx, cy] of spots) {
    if (lensFits(cx, cy, canvas) && clearsCursor(cx, cy, sx, sy)) return { cx, cy }
  }
  const inset = LOUPE_MARGIN + LOUPE_RADIUS
  const corners: Array<[number, number]> = [
    [canvas - inset, inset],
    [inset, inset],
    [canvas - inset, canvas - inset],
    [inset, canvas - inset],
  ]
  let best = corners[0]
  let bestDist = -1
  for (const corner of corners) {
    const dist = Math.hypot(corner[0] - sx, corner[1] - sy)
    if (dist > bestDist) {
      bestDist = dist
      best = corner
    }
  }
  return { cx: best[0], cy: best[1] }
}

function stepLoupeZoom(deltaY: number) {
  loupeZoom.value = nextLoupeZoom(loupeZoom.value, deltaY)
}

export function useLoupeControls() {
  const canZoomOut = computed(() => loupeZoom.value > LOUPE_ZOOM_MIN)
  const canZoomIn = computed(() => loupeZoom.value < LOUPE_ZOOM_MAX)

  function toggleLoupe() {
    loupeOn.value = !loupeOn.value
  }

  return { loupeOn, loupeZoom, canZoomOut, canZoomIn, toggleLoupe, stepLoupeZoom }
}

export function useCanvasLoupe(
  tool: () => EditorTool,
  fontToScreen: (pt: Pt) => { x: number; y: number },
  eventToFont: (event: PointerEvent | MouseEvent) => Pt | null,
) {
  const loupeVisible = ref(false)
  const loupeFont = ref<Pt | null>(null)

  const loupeEnabled = computed(() => loupeOn.value && isLoupeTool(tool()))

  const loupeScreen = computed(() => {
    const pt = loupeFont.value
    if (!pt) return null
    return fontToScreen(pt)
  })

  const loupeLens = computed(() => {
    const s = loupeScreen.value
    if (!s) return null
    return { ...placeLoupe(s.x, s.y), sx: s.x, sy: s.y }
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
    loupeZoom,
    LOUPE_RADIUS,
    onCanvasPointerMove,
    onCanvasPointerLeave,
    stepLoupeZoom,
  }
}
