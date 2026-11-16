import type { Pt } from '../paths.ts'
import { pixelPointToFont, type Raster } from './raster.ts'

const OUTLINE_SIMPLIFY = 1.5
const MIN_LOOP_POINTS = 12
const MIN_LOOP_AREA = 20
// Chaikin 코너 깎기: 가까운 점/먼 점 가중치
const CHAIKIN_NEAR = 0.75
const CHAIKIN_FAR = 0.25

export function pointSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

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
      const area = Math.abs(shoelace(pts))
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

function shoelace(pts: Pt[]): number {
  let sum = 0
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
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

// 구멍으로 인정하는 최소 크기(픽셀 수). 이보다 작은 틈은 래스터 오차로 보고 메운다.
const HOLE_MIN_PIXELS = 30

// 마스크 안쪽에 갇힌 빈 영역(구멍)들을 구멍마다 마스크로 돌려준다. 빈 칸은 4방향 연결로 본다(잉크의 8방향 연결과 짝).
function enclosedHoles(mask: Uint8Array, w: number, h: number): Uint8Array[] {
  const outside = new Uint8Array(mask.length)
  const stack: number[] = []
  const visit = (index: number) => {
    if (mask[index] || outside[index]) return
    outside[index] = 1
    stack.push(index)
  }
  for (let x = 0; x < w; x++) {
    visit(x)
    visit((h - 1) * w + x)
  }
  for (let y = 0; y < h; y++) {
    visit(y * w)
    visit(y * w + w - 1)
  }
  const flood = (seen: Uint8Array, pixels: number[]) => {
    while (stack.length > 0) {
      const index = stack.pop() as number
      pixels.push(index)
      const x = index % w
      const y = (index / w) | 0
      if (x > 0) visitInto(seen, index - 1)
      if (x < w - 1) visitInto(seen, index + 1)
      if (y > 0) visitInto(seen, index - w)
      if (y < h - 1) visitInto(seen, index + w)
    }
  }
  const visitInto = (seen: Uint8Array, index: number) => {
    if (mask[index] || seen[index]) return
    seen[index] = 1
    stack.push(index)
  }
  flood(outside, [])
  const holes: Uint8Array[] = []
  const labeled = outside.slice()
  for (let start = 0; start < mask.length; start++) {
    if (mask[start] || labeled[start]) continue
    labeled[start] = 1
    stack.push(start)
    const pixels: number[] = []
    flood(labeled, pixels)
    if (pixels.length < HOLE_MIN_PIXELS) continue
    const hole = new Uint8Array(mask.length)
    for (const index of pixels) hole[index] = 1
    holes.push(hole)
  }
  return holes
}

// 구멍 마스크를 8방향으로 한 칸 넓힌다. 넓힌 가장자리가 구멍 둘레의 잉크 픽셀을 지나게 해서, 바깥 윤곽이 잉크 가장자리를 따라가는 것과 같은 기준으로 구멍 윤곽을 뽑는다.
function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
  const grown = mask.slice()
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const x = i % w
    const y = (i / w) | 0
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx
        const ny = y + dy
        if (nx >= 0 && ny >= 0 && nx < w && ny < h) grown[ny * w + nx] = 1
      }
    }
  }
  return grown
}

// 마스크의 윤곽 경로: 바깥 윤곽에 안쪽 구멍 윤곽(감는 방향을 거꾸로)을 더한다. 잉크가 없으면 null.
// outlineOfLoop(traceLoops(...)[0])는 바깥 윤곽만 줘서 고리 모양(田·日 등)의 구멍이 메워진다.
export function outlineOfMask(mask: Uint8Array, raster: Raster): string | null {
  const { w, h } = raster
  const outer = traceLoops(mask, w, h)[0]
  if (!outer) return null
  const outerSign = Math.sign(shoelace(outer))
  const parts = [outlineOfLoop(outer, raster)]
  for (const hole of enclosedHoles(mask, w, h)) {
    const loop = traceLoops(dilate(hole, w, h), w, h)[0]
    if (!loop) continue
    parts.push(outlineOfLoop(Math.sign(shoelace(loop)) === outerSign ? loop.slice().reverse() : loop, raster))
  }
  return parts.join(' ')
}
