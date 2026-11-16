import { DEFAULT_STROKE_WIDTH } from '../constants.ts'
import { flattenContours, type Pt } from '../paths.ts'
import { outlineOfLoop, traceLoops } from './contour.ts'
import { pixelToFont, rasterize } from './raster.ts'

// 칼 분할과 중심선 기준 분할이 윤곽을 평탄화할 때 쓰는 허용 오차
export const KNIFE_FLATNESS = 1.4
const KNIFE_MIN_LENGTH = 4
// 칼로 나눈 두 조각이 서로의 접합부로 넘어가 겹치는 깊이: 기본 획 폭 대비 비율.
// 겹치지 않으면 칼이 경계에서 조금만 어긋나도 한쪽 조각이 파이거나 상대의 뿌리가 혹으로 남는다.
const KNIFE_OVERLAP_RATIO = 0.1
// 칼에 닿은 픽셀로 보는 거리(픽셀 단위)
const KNIFE_CONTACT_PX = 1.5

// own 조각이 칼 선에 닿은 픽셀을 기준으로, 반대편(other) 잉크를 radiusPx 이내만큼 own에 더한다.
function extendIntoOther(own: Uint8Array, other: Uint8Array, distancePx: Float32Array, w: number, h: number, radiusPx: number): Uint8Array {
  const extended = own.slice()
  for (let i = 0; i < own.length; i++) {
    if (!own[i] || Math.abs(distancePx[i]) > KNIFE_CONTACT_PX) continue
    const cx = i % w
    const cy = (i / w) | 0
    for (let dy = -radiusPx; dy <= radiusPx; dy++) {
      const py = cy + dy
      if (py < 0 || py >= h) continue
      for (let dx = -radiusPx; dx <= radiusPx; dx++) {
        if (dx * dx + dy * dy > radiusPx * radiusPx) continue
        const px = cx + dx
        if (px < 0 || px >= w) continue
        const index = py * w + px
        if (other[index]) extended[index] = 1
      }
    }
  }
  return extended
}

export function splitStrokeByKnife(strokePath: string, knifeStart: Pt, knifeEnd: Pt): [string, string] | null {
  const contours = flattenContours(strokePath, KNIFE_FLATNESS)
  if (contours.length === 0) return null
  const raster = rasterize(contours)
  const { w, h, ink } = raster
  const leftMask = new Uint8Array(w * h)
  const rightMask = new Uint8Array(w * h)
  // 칼 선까지의 부호 있는 거리(픽셀 단위). 양수가 왼쪽이다.
  const distancePx = new Float32Array(w * h)
  const dx = knifeEnd.x - knifeStart.x
  const dy = knifeEnd.y - knifeStart.y
  const length = Math.hypot(dx, dy)
  if (length < KNIFE_MIN_LENGTH) return null
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i]) continue
    const pt = pixelToFont(raster, i)
    const cross = (pt.x - knifeStart.x) * dy - (pt.y - knifeStart.y) * dx
    distancePx[i] = (cross / length) * raster.scale
    if (cross >= 0) leftMask[i] = 1
    else rightMask[i] = 1
  }
  const overlapPx = Math.max(1, Math.round(DEFAULT_STROKE_WIDTH * KNIFE_OVERLAP_RATIO * raster.scale))
  const loopsA = traceLoops(extendIntoOther(leftMask, rightMask, distancePx, w, h, overlapPx), w, h)
  const loopsB = traceLoops(extendIntoOther(rightMask, leftMask, distancePx, w, h, overlapPx), w, h)
  if (loopsA.length === 0 || loopsB.length === 0) return null
  return [
    outlineOfLoop(loopsA[0], raster),
    outlineOfLoop(loopsB[0], raster),
  ]
}
