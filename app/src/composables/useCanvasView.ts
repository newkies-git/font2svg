import { computed, ref, type Ref } from 'vue'
import { FULL_CANVAS_VIEW, isFullView, panView, viewFromSelection, zoomViewAt, type CanvasView } from '../lib/canvasView.ts'

const MOUSE_LEFT = 0
const MOUSE_MIDDLE = 1

type Marquee = { x0: number; y0: number; x1: number; y1: number }

// 캔버스 확대·이동 상태. 돋보기 영역 확대(왼쪽 드래그), 가운데 버튼 이동, 휠 확대를 맡는다.
export function useCanvasView(svgEl: Ref<SVGSVGElement | null>) {
  const view = ref<CanvasView>({ ...FULL_CANVAS_VIEW })
  const zoomArmed = ref(false)
  const marquee = ref<Marquee | null>(null)
  const zoomed = computed(() => !isFullView(view.value))
  const viewBoxAttr = computed(() => `${view.value.x} ${view.value.y} ${view.value.w} ${view.value.h}`)

  function clientToSvg(event: PointerEvent | WheelEvent): { x: number; y: number } | null {
    const ctm = svgEl.value?.getScreenCTM()
    if (!ctm) return null
    const pt = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse())
    return { x: pt.x, y: pt.y }
  }

  function toggleZoomArm() {
    zoomArmed.value = !zoomArmed.value
    marquee.value = null
  }

  function resetView() {
    view.value = { ...FULL_CANVAS_VIEW }
    zoomArmed.value = false
    marquee.value = null
  }

  function startMarquee(event: PointerEvent) {
    const origin = clientToSvg(event)
    if (!origin) return
    marquee.value = { x0: origin.x, y0: origin.y, x1: origin.x, y1: origin.y }
    const move = (moveEvent: PointerEvent) => {
      const cur = clientToSvg(moveEvent)
      if (!cur || !marquee.value) return
      marquee.value = { ...marquee.value, x1: cur.x, y1: cur.y }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const box = marquee.value
      marquee.value = null
      zoomArmed.value = false
      if (!box) return
      const next = viewFromSelection(box.x0, box.y0, box.x1, box.y1)
      if (next) view.value = next
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function startPan(event: PointerEvent) {
    const ctm = svgEl.value?.getScreenCTM()
    if (!ctm || ctm.a === 0 || ctm.d === 0) return
    const scaleX = ctm.a
    const scaleY = ctm.d
    const originX = event.clientX
    const originY = event.clientY
    const start = { ...view.value }
    const move = (moveEvent: PointerEvent) => {
      view.value = panView(start, (moveEvent.clientX - originX) / scaleX, (moveEvent.clientY - originY) / scaleY)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  function onZoomPointerDown(event: PointerEvent) {
    if (event.button === MOUSE_MIDDLE) {
      event.preventDefault()
      event.stopPropagation()
      startPan(event)
      return
    }
    if (!zoomArmed.value || event.button !== MOUSE_LEFT) return
    event.stopPropagation()
    startMarquee(event)
  }

  // 휠로 커서 위치를 기준으로 확대·축소한다. 캔버스 좌표를 얻지 못하면 아무것도 하지 않는다.
  function zoomByWheel(event: WheelEvent) {
    const at = clientToSvg(event)
    if (!at) return
    event.preventDefault()
    view.value = zoomViewAt(view.value, at.x, at.y, event.deltaY < 0)
  }

  return { view, zoomArmed, marquee, zoomed, viewBoxAttr, toggleZoomArm, resetView, onZoomPointerDown, zoomByWheel }
}
