import { flattenContours, type Pt } from '../paths.ts'
import { outlineOfLoop, traceLoops } from './contour.ts'
import { pixelToFont, rasterize } from './raster.ts'

// 칼 분할과 중심선 기준 분할이 윤곽을 평탄화할 때 쓰는 허용 오차
export const KNIFE_FLATNESS = 1.4
const KNIFE_MIN_LENGTH = 4

export function splitStrokeByKnife(strokePath: string, knifeStart: Pt, knifeEnd: Pt): [string, string] | null {
  const contours = flattenContours(strokePath, KNIFE_FLATNESS)
  if (contours.length === 0) return null
  const raster = rasterize(contours)
  const { w, h, ink } = raster
  const leftMask = new Uint8Array(w * h)
  const rightMask = new Uint8Array(w * h)
  const dx = knifeEnd.x - knifeStart.x
  const dy = knifeEnd.y - knifeStart.y
  if (Math.hypot(dx, dy) < KNIFE_MIN_LENGTH) return null
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i]) continue
    const pt = pixelToFont(raster, i)
    const cross = (pt.x - knifeStart.x) * dy - (pt.y - knifeStart.y) * dx
    if (cross >= 0) leftMask[i] = 1
    else rightMask[i] = 1
  }
  const loopsA = traceLoops(leftMask, w, h)
  const loopsB = traceLoops(rightMask, w, h)
  if (loopsA.length === 0 || loopsB.length === 0) return null
  return [
    outlineOfLoop(loopsA[0], raster),
    outlineOfLoop(loopsB[0], raster),
  ]
}
