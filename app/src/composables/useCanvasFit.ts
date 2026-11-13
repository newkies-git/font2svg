import { computed, type Ref } from 'vue'
import { CANVAS } from '../lib/constants.ts'
import { pathsBBox, strokesBBox, type BBox } from '../lib/vectorEdit.ts'
import type { LayerRecord, Pt, StrokeRecord } from '../types.ts'

export function visibleWorkStrokes(strokes: StrokeRecord[], shown: number): StrokeRecord[] {
  return strokes.slice(0, Math.max(0, Math.min(strokes.length, shown)))
}

export function useCanvasFit(
  orderedLayers: () => LayerRecord[],
  shown: () => number,
  worldGroup: Ref<SVGGElement | null>,
) {
  /** 글자 윤곽이 0~CANVAS를 벗어날 때 균등 축소·중앙 정렬해 캔버스 안에 넣는다. */
  const FIT_PAD = CANVAS * 0.05

  const contentBBox = computed<BBox | null>(() => {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const absorb = (b: BBox | null) => {
      if (!b) return
      if (b.minX < minX) minX = b.minX
      if (b.minY < minY) minY = b.minY
      if (b.maxX > maxX) maxX = b.maxX
      if (b.maxY > maxY) maxY = b.maxY
    }
    for (const layer of orderedLayers()) {
      if (!layer.visible) continue
      if (layer.kind === 'MEDIANS' || layer.kind === 'NUMBERS') continue
      if (layer.strokes.length > 0) {
        const list = layer.kind === 'STROKES' ? visibleWorkStrokes(layer.strokes, shown()) : layer.strokes
        absorb(strokesBBox(list))
      } else if (layer.paths.length > 0) {
        absorb(pathsBBox(layer.paths))
      }
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null
  })

  const contentFit = computed(() => {
    const b = contentBBox.value
    if (!b) return { scale: 1, ox: 0, oy: 0 }
    const overflows = b.minX < 0 || b.minY < 0 || b.maxX > CANVAS || b.maxY > CANVAS
    if (!overflows) return { scale: 1, ox: 0, oy: 0 }
    const bw = Math.max(1, b.maxX - b.minX)
    const bh = Math.max(1, b.maxY - b.minY)
    const inner = CANVAS - 2 * FIT_PAD
    // 넘칠 때만 축소·중앙 정렬한다. 이미 들어가는 글자는 키우지 않는다.
    const scale = Math.min(inner / bw, inner / bh, 1)
    const cx = (b.minX + b.maxX) / 2
    const cy = (b.minY + b.maxY) / 2
    return {
      scale,
      ox: CANVAS / 2 - cx * scale,
      oy: CANVAS / 2 - cy * scale,
    }
  })

  const worldTransform = computed(() => {
    const { scale, ox, oy } = contentFit.value
    if (scale === 1 && ox === 0 && oy === 0) return `translate(0 ${CANVAS}) scale(1 -1)`
    return `translate(0 ${CANVAS}) scale(1 -1) translate(${ox} ${oy}) scale(${scale})`
  })

  function fontToScreen(pt: Pt): { x: number; y: number } {
    const { scale, ox, oy } = contentFit.value
    const fx = ox + pt[0] * scale
    const fy = oy + pt[1] * scale
    return { x: fx, y: CANVAS - fy }
  }

  function eventToFont(event: PointerEvent | MouseEvent): Pt | null {
    const ctm = worldGroup.value?.getScreenCTM()
    if (!ctm) return null
    const pt = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse())
    return [pt.x, pt.y]
  }

  return { worldTransform, fontToScreen, eventToFont }
}
