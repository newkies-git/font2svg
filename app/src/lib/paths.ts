export type Pt = { x: number; y: number }

type Cmd = { op: 'M' | 'L' | 'Q' | 'C' | 'Z'; n: number[] }

import { COORD_DECIMALS, COORD_ROUND } from './constants.ts'

const NUM = /-?(?:\d+\.\d+|\d+|\.\d+)/g
const SAFE_SVG_PATH_RE = /^[MLHVCSQTZmlhvcsqtz0-9.,\s-]+$/
const MAX_PATH_LENGTH = 200_000

export function isValidSvgPath(d: string): boolean {
  const trimmed = d.trim()
  if (!trimmed || trimmed.length > MAX_PATH_LENGTH) return false
  if (!SAFE_SVG_PATH_RE.test(trimmed)) return false
  return /^[Mm]/.test(trimmed) && /[Zz]\s*$/.test(trimmed)
}

export function roundPath1(d: string): string {
  const s = d.trim().replace(/\s+/g, ' ')
  return s.replace(NUM, (m) => {
    const v = Math.round(Number(m) * COORD_ROUND) / COORD_ROUND
    return Number.isInteger(v) ? String(v) : v.toFixed(COORD_DECIMALS)
  })
}

export function splitClosedSubpaths(d: string): string[] {
  const parts: string[] = []
  const re = /[Mm][^Mm]*?[Zz]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(d))) {
    const sub = m[0].trim()
    if (sub) parts.push(sub)
  }
  return parts.length > 0 ? parts : (d.trim() ? [d.trim()] : [])
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
    const rawOp = m[1]
    const upper = rawOp.toUpperCase()
    const rel = rawOp !== upper
    const nums = (m[2].match(NUM) ?? []).map(Number)
    if (upper === 'Z') {
      out.push({ op: 'Z', n: [] })
      cx = sx
      cy = sy
    } else if (upper === 'M') {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        cx = rel ? cx + nums[i] : nums[i]
        cy = rel ? cy + nums[i + 1] : nums[i + 1]
        if (i === 0) {
          sx = cx
          sy = cy
          out.push({ op: 'M', n: [cx, cy] })
        } else {
          out.push({ op: 'L', n: [cx, cy] })
        }
      }
    } else if (upper === 'L') {
      for (let i = 0; i + 1 < nums.length; i += 2) {
        cx = rel ? cx + nums[i] : nums[i]
        cy = rel ? cy + nums[i + 1] : nums[i + 1]
        out.push({ op: 'L', n: [cx, cy] })
      }
    } else if (upper === 'H') {
      for (const v of nums) {
        cx = rel ? cx + v : v
        out.push({ op: 'L', n: [cx, cy] })
      }
    } else if (upper === 'V') {
      for (const v of nums) {
        cy = rel ? cy + v : v
        out.push({ op: 'L', n: [cx, cy] })
      }
    } else if (upper === 'Q') {
      for (let i = 0; i + 3 < nums.length; i += 4) {
        const x1 = rel ? cx + nums[i] : nums[i]
        const y1 = rel ? cy + nums[i + 1] : nums[i + 1]
        const x = rel ? cx + nums[i + 2] : nums[i + 2]
        const y = rel ? cy + nums[i + 3] : nums[i + 3]
        out.push({ op: 'Q', n: [x1, y1, x, y] })
        cx = x
        cy = y
      }
    } else if (upper === 'C') {
      for (let i = 0; i + 5 < nums.length; i += 6) {
        const x1 = rel ? cx + nums[i] : nums[i]
        const y1 = rel ? cy + nums[i + 1] : nums[i + 1]
        const x2 = rel ? cx + nums[i + 2] : nums[i + 2]
        const y2 = rel ? cy + nums[i + 3] : nums[i + 3]
        const x = rel ? cx + nums[i + 4] : nums[i + 4]
        const y = rel ? cy + nums[i + 5] : nums[i + 5]
        out.push({ op: 'C', n: [x1, y1, x2, y2, x, y] })
        cx = x
        cy = y
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
  if (depth > 8 || Math.hypot(midPt.x - chord.x, midPt.y - chord.y) <= flat) {
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
  if (depth > 8 || Math.max(ux * ux + uy * uy, vx * vx + vy * vy) <= flat * flat * 16) {
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
