import { DEFAULT_STROKE_WIDTH } from '../constants.ts'
import { flattenContours, type Pt } from '../paths.ts'
import { outlineOfLoop, pointSegmentDistance, traceLoops } from './contour.ts'
import { computeOptimalStrokeWidth } from './median.ts'
import { OUTLINE_FLATNESS, pixelToFont, rasterize } from './raster.ts'

// 교차부 공유 확장 반경: 기본 획 폭 대비 비율, 최소 픽셀
const COVER_RADIUS_RATIO = 0.42
const COVER_RADIUS_MIN_PX = 4

export function segmentOutlineByMedians(fullOutlinePaths: string[], medians: Pt[][], defaultWidth = DEFAULT_STROKE_WIDTH): {
  strokes: string[]
  widths: number[]
  coverage: number
} {
  const contours = fullOutlinePaths.flatMap((d) => flattenContours(d, OUTLINE_FLATNESS))
  if (contours.length === 0 || medians.length === 0) {
    return { strokes: [], widths: [], coverage: 0 }
  }
  const raster = rasterize(contours)
  const { w, h, ink } = raster
  const strokeMasks = medians.map(() => new Uint8Array(w * h))

  // 1차 브러시 교집합 분할 + 잔여 조각 최근접 중심선 흡수
  let coveredPixels = 0
  let totalInk = 0
  for (let i = 0; i < ink.length; i++) {
    if (!ink[i]) continue
    totalInk++
    const pt = pixelToFont(raster, i)
    let bestIdx = 0
    let bestDist = Infinity
    for (let s = 0; s < medians.length; s++) {
      const med = medians[s]
      for (let j = 0; j < med.length - 1; j++) {
        const d = pointSegmentDistance(pt, med[j], med[j + 1])
        if (d < bestDist) {
          bestDist = d
          bestIdx = s
        }
      }
    }
    strokeMasks[bestIdx][i] = 1
    coveredPixels++
  }

  // 교차점 부근 공유 확장(숨겨진 기필/수필 및 교차부 연속성 확보)
  const radiusPx = Math.max(COVER_RADIUS_MIN_PX, Math.round((defaultWidth * COVER_RADIUS_RATIO) * raster.scale))
  for (let s = 0; s < medians.length; s++) {
    const med = medians[s]
    const mask = strokeMasks[s]
    for (let j = 0; j < med.length - 1; j++) {
      const steps = Math.max(2, Math.ceil(Math.hypot(med[j + 1].x - med[j].x, med[j + 1].y - med[j].y) * raster.scale / 2))
      for (let k = 0; k <= steps; k++) {
        const u = k / steps
        const fx = med[j].x + (med[j + 1].x - med[j].x) * u
        const fy = med[j].y + (med[j + 1].y - med[j].y) * u
        const cx = Math.round(raster.pad + (fx - raster.minX) * raster.scale)
        const cy = Math.round(raster.pad + (raster.maxY - fy) * raster.scale)
        for (let dy = -radiusPx; dy <= radiusPx; dy++) {
          const py = cy + dy
          if (py < 0 || py >= h) continue
          for (let dx = -radiusPx; dx <= radiusPx; dx++) {
            if (dx * dx + dy * dy > radiusPx * radiusPx) continue
            const px = cx + dx
            if (px < 0 || px >= w) continue
            const idx = py * w + px
            if (ink[idx]) mask[idx] = 1
          }
        }
      }
    }
  }

  const strokes: string[] = []
  const widths: number[] = []
  for (let s = 0; s < medians.length; s++) {
    const loops = traceLoops(strokeMasks[s], w, h)
    const path = loops.length > 0 ? outlineOfLoop(loops[0], raster) : (fullOutlinePaths[s] ?? fullOutlinePaths[0] ?? '')
    strokes.push(path)
    widths.push(computeOptimalStrokeWidth(path, medians[s], defaultWidth))
  }
  return {
    strokes,
    widths,
    coverage: totalInk > 0 ? coveredPixels / totalInk : 1,
  }
}
