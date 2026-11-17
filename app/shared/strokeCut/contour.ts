import { polygonArea, type Pt } from '../paths.ts'
import { dilate, enclosedHoles } from './mask.ts'
import { pixelPointToFont, type Raster } from './raster.ts'

const OUTLINE_SIMPLIFY = 1.5
const MIN_LOOP_POINTS = 12
const MIN_LOOP_AREA = 20
// Chaikin 코너 깎기: 가까운 점/먼 점 가중치
const CHAIKIN_NEAR = 0.75
const CHAIKIN_FAR = 0.25

export function traceLoops(mask: Uint8Array, w: number, h: number): Pt[][] {
  const used = new Uint8Array(w * h)
  const loops: { pts: Pt[]; area: number }[] = []
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!mask[i] || used[i]) continue
      if (x > 0 && mask[i - 1]) continue
      const pts = moore(mask, w, h, x, y)
      if (pts.length < MIN_LOOP_POINTS) continue
      for (const point of pts) used[point.y * w + point.x] = 1
      const area = Math.abs(polygonArea(pts))
      if (area > MIN_LOOP_AREA) loops.push({ pts, area })
    }
  }
  loops.sort((a, b) => b.area - a.area)
  if (loops.length === 0) return []
  return [loops[0].pts]
}

const MOORE = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
]

function moore(mask: Uint8Array, w: number, h: number, sx: number, sy: number): Pt[] {
  const pts: Pt[] = []
  let x = sx
  let y = sy
  let dir = 6
  const limit = w * h
  for (let guard = 0; guard < limit; guard++) {
    pts.push({ x, y })
    let found = false
    for (let turn = 0; turn < 8; turn++) {
      const nd = (dir + turn) % 8
      const nx = x + MOORE[nd][0]
      const ny = y + MOORE[nd][1]
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      if (!mask[ny * w + nx]) continue
      x = nx
      y = ny
      dir = (nd + 6) % 8
      found = true
      break
    }
    if (!found) break
    if (x === sx && y === sy) break
  }
  return pts
}

function chaikin(points: Pt[]): Pt[] {
  if (points.length < 4) return points
  const out: Pt[] = []
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    out.push({ x: a.x * CHAIKIN_NEAR + b.x * CHAIKIN_FAR, y: a.y * CHAIKIN_NEAR + b.y * CHAIKIN_FAR })
    out.push({ x: a.x * CHAIKIN_FAR + b.x * CHAIKIN_NEAR, y: a.y * CHAIKIN_FAR + b.y * CHAIKIN_NEAR })
  }
  return out
}

function rdp(points: Pt[], epsilon: number): Pt[] {
  if (points.length < 3) return points
  const closed = points[0].x === points[points.length - 1].x && points[0].y === points[points.length - 1].y
  const body = closed ? points.slice(0, -1) : points
  if (body.length < 3) return points
  let maxD = 0
  let index = 0
  const a = body[0]
  const b = body[body.length - 1]
  for (let i = 1; i < body.length - 1; i++) {
    const d = pointLineDistance(body[i], a, b)
    if (d > maxD) {
      maxD = d
      index = i
    }
  }
  if (maxD <= epsilon) return closed ? [a, b, a] : [a, b]
  const left = rdp(body.slice(0, index + 1), epsilon)
  const right = rdp(body.slice(index), epsilon)
  const merged = left.slice(0, -1).concat(right)
  return closed ? [...merged, merged[0]] : merged
}

export function simplifyPolyline(points: Pt[], tolerance: number): Pt[] {
  return rdp(points, tolerance)
}

function pointLineDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / len
}

function loopsToPath(loops: Pt[][], raster: Raster): string {
  return loops
    .map((loop) => {
      const head = pixelPointToFont(raster, loop[0])
      let d = `M${Math.round(head.x)} ${Math.round(head.y)}`
      for (let i = 1; i < loop.length; i++) {
        const point = pixelPointToFont(raster, loop[i])
        d += `L${Math.round(point.x)} ${Math.round(point.y)}`
      }
      return `${d}Z`
    })
    .join(' ')
}

// 마스크에서 뽑은 바깥 윤곽 하나를 모서리를 깎고 단순화해 글꼴 좌표 경로로 만든다.
export function outlineOfLoop(loop: Pt[], raster: Raster): string {
  return loopsToPath([rdp(chaikin(loop), OUTLINE_SIMPLIFY)], raster)
}

// 마스크의 윤곽 경로: 바깥 윤곽에 안쪽 구멍 윤곽(감는 방향을 거꾸로)을 더한다. 잉크가 없으면 null.
// outlineOfLoop(traceLoops(...)[0])는 바깥 윤곽만 줘서 고리 모양(田·日 등)의 구멍이 메워진다.
export function outlineOfMask(mask: Uint8Array, raster: Raster): string | null {
  const { w, h } = raster
  const outer = traceLoops(mask, w, h)[0]
  if (!outer) return null
  const outerSign = Math.sign(polygonArea(outer))
  const parts = [outlineOfLoop(outer, raster)]
  for (const hole of enclosedHoles(mask, w, h)) {
    const loop = traceLoops(dilate(hole, w, h), w, h)[0]
    if (!loop) continue
    parts.push(outlineOfLoop(Math.sign(polygonArea(loop)) === outerSign ? loop.slice().reverse() : loop, raster))
  }
  return parts.join(' ')
}
