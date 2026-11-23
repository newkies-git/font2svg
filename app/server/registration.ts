import { strokeWidthCap } from '../shared/clamp.ts'
import { DEFAULT_STROKE_WIDTH, FIT_MIN_GAIN, MIN_STROKE_WIDTH } from '../shared/constants.ts'
import { assignRegions, CELL, centroidOf, fillMask, IDENTITY, iou, loopsOf, mapFor, optimize, type Loop } from '../shared/fitCore.ts'
import type { Pt } from '../shared/types.ts'

// 참고 중심선을 궁서체 글자에 획마다 맞추는 등록. 글자 전체를 bbox로 한 번 늘이고 옮기는 것(fitMediansToOutline)만으로는
// 폰트마다 다른 획 위치·길이·기울기를 못 따라가서, 작은 획이 이웃 획에게 잉크를 빼앗기고 띠로 대체되는 일이 생긴다.
// 획마다 중심선 둘레의 띠 모양을 만들어 그 획이 맡을 글자 영역(가까운 중심선 기준)과의 겹침(IoU)이 최대가 되도록
// 이동·확대·회전·기울임을 찾고, 같은 변환을 중심선에 적용한다. 영역은 맞춘 중심선으로 다시 나누며 REGISTER_ROUNDS번 되풀이한다.
const REGISTER_ROUNDS = 2
// 영역이 이 칸 수보다 작은 획(점 등)은 겹침이 불안정해 맞추지 않는다.
const MIN_REGION_CELLS = 6
const MIN_MEDIAN_LENGTH = 1

type Ribbon = (median: Pt[], width: number) => string

const medianLength = (median: Pt[]): number => median.slice(1).reduce((sum, point, index) => sum + Math.hypot(point[0] - median[index][0], point[1] - median[index][1]), 0)
const countOf = (mask: Uint8Array): number => mask.reduce((sum, value) => sum + value, 0)

// 영역 면적을 중심선 길이로 나눠 그 획의 대략적인 폭으로 쓴다(겹친 영역은 작게 나오므로 최소·상한으로 가둔다).
function regionWidth(region: Uint8Array, length: number): number {
  const area = countOf(region) * CELL * CELL
  return Math.min(strokeWidthCap(DEFAULT_STROKE_WIDTH), Math.max(MIN_STROKE_WIDTH, area / Math.max(length, MIN_MEDIAN_LENGTH)))
}

// 영역(region)에 더해, 다른 획들의 윤곽이 덮지 않은 글자 칸을 합친 목표 마스크.
function uncoveredBy(fontMask: Uint8Array, region: Uint8Array, shapes: Loop[][] | null, self: number): Uint8Array {
  const covered = new Uint8Array(fontMask.length)
  shapes?.forEach((loops, index) => {
    if (index === self || loops.length === 0) return
    const mask = fillMask(loops)
    for (let i = 0; i < mask.length; i++) if (mask[i]) covered[i] = 1
  })
  const target = region.slice()
  for (let i = 0; i < target.length; i++) if (fontMask[i] && !covered[i]) target[i] = 1
  return target
}

// guide: bbox로 먼저 맞춘 중심선들. shapes는 같은 변환을 거친 각 획의 실제 윤곽(참고 출처의 굵기를 가진 모양)이고,
// 있으면 띠 대신 그것으로 겹침을 잰다(굵기가 맞아 띠보다 정확하다). 맞출 수 없으면 입력을 그대로 돌려준다.
export function registerMedians(guide: Pt[][], contours: string[], ribbon: Ribbon, shapes?: Loop[][]): Pt[][] {
  const fontLoops = loopsOf(contours)
  if (fontLoops.length === 0 || guide.length === 0) return guide
  const fontMask = fillMask(fontLoops)
  let medians = guide
  let outlineLoops = shapes && shapes.length === guide.length ? shapes : null
  for (let round = 0; round < REGISTER_ROUNDS; round++) {
    const regions = assignRegions(fontMask, medians)
    const nextLoops: Loop[][] = []
    medians = medians.map((median, index) => {
      const region = regions[index]
      const own = outlineLoops?.[index] ?? []
      nextLoops.push(own)
      const length = medianLength(median)
      if (countOf(region) < MIN_REGION_CELLS || length < MIN_MEDIAN_LENGTH) return median
      const loops = own.length > 0 ? own : loopsOf([ribbon(median, regionWidth(region, length))])
      if (loops.length === 0) return median
      const center = centroidOf(loops)
      // 실제 윤곽이 있으면, 가까운 영역에 더해 다른 획이 덮지 못한 글자 부분까지 이 획의 몫으로 본다(획이 이웃에게 삼켜지거나 비어 보이는 것을 막는다).
      const target = own.length > 0 ? uncoveredBy(fontMask, region, outlineLoops, index) : region
      const before = iou(fillMask(loops), target)
      const fit = optimize(loops, center, target, IDENTITY)
      if (fit.score <= before + FIT_MIN_GAIN) return median
      const move = mapFor(fit.params, center)
      nextLoops[index] = own.map((loop) => loop.map((point) => {
        const [x, y] = move(point.x, point.y)
        return { x, y }
      }))
      return median.map(([x, y]): Pt => move(x, y))
    })
    if (outlineLoops) outlineLoops = nextLoops
  }
  return medians
}
