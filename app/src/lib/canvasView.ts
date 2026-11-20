import { CANVAS } from '../../shared/constants.ts'

// SVG viewBox. 글꼴 좌표가 아니라 화면(캔버스) 좌표다.
export type CanvasView = { x: number; y: number; w: number; h: number }

export const FULL_CANVAS_VIEW: CanvasView = { x: 0, y: 0, w: CANVAS, h: CANVAS }

// 이보다 작게 확대하지 않는다. 점 하나가 화면을 다 채우지 않게 하는 하한이다.
const MIN_SPAN = 32
const WHEEL_FACTOR = 1.2
// 클릭과 영역 드래그를 구분하는 최소 크기
const MIN_DRAG = 4

export function isFullView(view: CanvasView): boolean {
  return view.x === 0 && view.y === 0 && view.w === CANVAS && view.h === CANVAS
}

function clampSpan(span: number): number {
  return Math.min(CANVAS, Math.max(MIN_SPAN, span))
}

// 드래그한 사각형을 캔버스에 채운다. 너무 작은 움직임은 클릭으로 보고 바꾸지 않는다.
export function viewFromSelection(x0: number, y0: number, x1: number, y1: number): CanvasView | null {
  let x = Math.min(x0, x1)
  let y = Math.min(y0, y1)
  let w = Math.abs(x1 - x0)
  let h = Math.abs(y1 - y0)
  if (w < MIN_DRAG && h < MIN_DRAG) return null
  if (w < MIN_SPAN) {
    x -= (MIN_SPAN - w) / 2
    w = MIN_SPAN
  }
  if (h < MIN_SPAN) {
    y -= (MIN_SPAN - h) / 2
    h = MIN_SPAN
  }
  return { x, y, w, h }
}

// 커서(sx, sy)가 화면의 같은 자리에 남도록 배율을 바꾼다. 전체보다 더 축소하지는 않는다.
export function zoomViewAt(view: CanvasView, sx: number, sy: number, zoomIn: boolean): CanvasView {
  const factor = zoomIn ? 1 / WHEEL_FACTOR : WHEEL_FACTOR
  const w = clampSpan(view.w * factor)
  const h = clampSpan(view.h * factor)
  if (w === CANVAS && h === CANVAS) return { ...FULL_CANVAS_VIEW }
  const rx = view.w === 0 ? 0.5 : (sx - view.x) / view.w
  const ry = view.h === 0 ? 0.5 : (sy - view.y) / view.h
  return { x: sx - rx * w, y: sy - ry * h, w, h }
}

export function panView(view: CanvasView, dx: number, dy: number): CanvasView {
  return { ...view, x: view.x - dx, y: view.y - dy }
}
