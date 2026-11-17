import { COORD_ROUND } from './constants.ts'

export type Pt = { x: number; y: number }

type Cmd = { op: 'M' | 'L' | 'Q' | 'C' | 'Z'; n: number[] }

// 베지어 평탄화: 재귀 깊이 한계(2차·3차 공통)와, 3차에서 제어점 편차(제곱)를 허용 오차(제곱)와 비교하는 배율
const FLATTEN_MAX_DEPTH = 8
const FLATTEN_TOLERANCE_FACTOR = 16

// 저장 좌표는 소수점 1자리로 반올림한다(COORD_ROUND).
export function round1(value: number): number {
  return Math.round(value * COORD_ROUND) / COORD_ROUND
}

const NUM = /-?(?:\d+\.\d+|\d+|\.\d+)/g
const SAFE_SVG_PATH_RE = /^[MLHVCSQTZmlhvcsqtz0-9.,\s-]+$/
const MAX_PATH_LENGTH = 200_000

export function isValidSvgPath(d: string): boolean {
  const trimmed = d.trim()
  if (!trimmed || trimmed.length > MAX_PATH_LENGTH) return false
  if (!SAFE_SVG_PATH_RE.test(trimmed)) return false
  return /^[Mm]/.test(trimmed) && /[Zz]\s*$/.test(trimmed)
}

// 숫자 목록을 size개씩 묶는다. 모자란 끝 조각은 버린다.
function chunksOf(nums: number[], size: number): number[][] {
  const chunks: number[][] = []
  for (let i = 0; i + size <= nums.length; i += size) chunks.push(nums.slice(i, i + size))
  return chunks
}

// 명령 하나가 받는 좌표 쌍 묶음의 숫자 개수: 한 점(M·L)은 2, 2차 곡선은 4, 3차 곡선은 6
const CURVE_ARITY: Record<'L' | 'Q' | 'C', number> = { L: 2, Q: 4, C: 6 }

// 상대 명령(소문자)은 묶음의 시작에서의 현재 점을 기준으로 절대 좌표로 바꾼다. 홀수 번째가 x, 짝수 번째가 y이다.
function toAbsolute(chunk: number[], relative: boolean, cx: number, cy: number): number[] {
  return relative ? chunk.map((value, i) => value + (i % 2 === 0 ? cx : cy)) : chunk
}

export function parseCommands(d: string): Cmd[] {
  const out: Cmd[] = []
  const re = /([MLHVQCZ])([^MLHVQCZ]*)/gi
  let m: RegExpExecArray | null
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0
  while ((m = re.exec(d))) {
    const upper = m[1].toUpperCase()
    const relative = m[1] !== upper
    const nums = (m[2].match(NUM) ?? []).map(Number)
    if (upper === 'Z') {
      out.push({ op: 'Z', n: [] })
      cx = sx
      cy = sy
    } else if (upper === 'M' || upper === 'L') {
      // M의 첫 점만 이동이고, 뒤따르는 점은 선으로 잇는다.
      chunksOf(nums, CURVE_ARITY.L).forEach((chunk, i) => {
        const [x, y] = toAbsolute(chunk, relative, cx, cy)
        cx = x
        cy = y
        if (upper === 'M' && i === 0) {
          sx = cx
          sy = cy
          out.push({ op: 'M', n: [cx, cy] })
        } else {
          out.push({ op: 'L', n: [cx, cy] })
        }
      })
    } else if (upper === 'H' || upper === 'V') {
      for (const value of nums) {
        if (upper === 'H') cx = relative ? cx + value : value
        else cy = relative ? cy + value : value
        out.push({ op: 'L', n: [cx, cy] })
      }
    } else if (upper === 'Q' || upper === 'C') {
      for (const chunk of chunksOf(nums, CURVE_ARITY[upper])) {
        const n = toAbsolute(chunk, relative, cx, cy)
        out.push({ op: upper, n })
        cx = n[n.length - 2]
        cy = n[n.length - 1]
      }
    }
  }
  return out
}

export function pathBBox(d: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const pts = samplePath(d, 6)
  if (pts.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

export function samplePath(d: string, flatness: number): Pt[] {
  const pts: Pt[] = []
  for (const contour of flattenContours(d, flatness)) pts.push(...contour)
  return pts
}

// 꼭짓점으로 이은 다각형의 부호 있는 면적(신발끈 공식). 감는 방향에 따라 부호가 다르다.
export function polygonArea(points: Pt[]): number {
  let twice = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    twice += a.x * b.y - b.x * a.y
  }
  return twice / 2
}

// 점 p에서 선분 ab까지의 최단 거리. 선분이 한 점이면 그 점까지의 거리다.
export function pointSegmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export function flattenContours(d: string, flatness: number): Pt[][] {
  const contours: Pt[][] = []
  let current: Pt[] = []
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0

  const push = (p: Pt) => {
    const last = current[current.length - 1]
    if (!last || last.x !== p.x || last.y !== p.y) current.push(p)
  }

  for (const cmd of parseCommands(d)) {
    if (cmd.op === 'M') {
      if (current.length > 1) contours.push(current)
      cx = cmd.n[0]
      cy = cmd.n[1]
      sx = cx
      sy = cy
      current = [{ x: cx, y: cy }]
    } else if (cmd.op === 'L') {
      cx = cmd.n[0]
      cy = cmd.n[1]
      push({ x: cx, y: cy })
    } else if (cmd.op === 'Q') {
      const p1 = { x: cmd.n[0], y: cmd.n[1] }
      const p2 = { x: cmd.n[2], y: cmd.n[3] }
      flattenQuadratic({ x: cx, y: cy }, p1, p2, flatness, push)
      cx = p2.x
      cy = p2.y
    } else if (cmd.op === 'C') {
      const p1 = { x: cmd.n[0], y: cmd.n[1] }
      const p2 = { x: cmd.n[2], y: cmd.n[3] }
      const p3 = { x: cmd.n[4], y: cmd.n[5] }
      flattenCubic({ x: cx, y: cy }, p1, p2, p3, flatness, push)
      cx = p3.x
      cy = p3.y
    } else if (cmd.op === 'Z') {
      push({ x: sx, y: sy })
      if (current.length > 1) contours.push(current)
      current = []
    }
  }
  if (current.length > 1) contours.push(current)
  return contours
}

function flattenQuadratic(p0: Pt, p1: Pt, p2: Pt, flat: number, push: (p: Pt) => void, depth = 0) {
  const midPt = { x: (p0.x + 2 * p1.x + p2.x) / 4, y: (p0.y + 2 * p1.y + p2.y) / 4 }
  const chord = { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 }
  if (depth > FLATTEN_MAX_DEPTH || Math.hypot(midPt.x - chord.x, midPt.y - chord.y) <= flat) {
    push(p2)
    return
  }
  const a = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
  const b = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  flattenQuadratic(p0, a, c, flat, push, depth + 1)
  flattenQuadratic(c, b, p2, flat, push, depth + 1)
}

function flattenCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, flat: number, push: (p: Pt) => void, depth = 0) {
  const ux = 3 * p1.x - 2 * p0.x - p3.x
  const uy = 3 * p1.y - 2 * p0.y - p3.y
  const vx = 3 * p2.x - 2 * p3.x - p0.x
  const vy = 3 * p2.y - 2 * p3.y - p0.y
  if (depth > FLATTEN_MAX_DEPTH || Math.max(ux * ux + uy * uy, vx * vx + vy * vy) <= flat * flat * FLATTEN_TOLERANCE_FACTOR) {
    push(p3)
    return
  }
  const p01 = mid(p0, p1)
  const p12 = mid(p1, p2)
  const p23 = mid(p2, p3)
  const p012 = mid(p01, p12)
  const p123 = mid(p12, p23)
  const p0123 = mid(p012, p123)
  flattenCubic(p0, p01, p012, p0123, flat, push, depth + 1)
  flattenCubic(p0123, p123, p23, p3, flat, push, depth + 1)
}

function mid(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}
