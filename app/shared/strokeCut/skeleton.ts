import type { Pt } from '../paths.ts'

// 골격 가지치기: 가지 탐색 최대 길이, 이 길이 미만이면 가지로 보고 지우는 기준, 반복 횟수
const SPUR_SCAN_LENGTH = 14
const SPUR_MAX_LENGTH = 12
const SPUR_PASSES = 6
const N8 = [1, -1, 0, 0, 1, 1, -1, -1]
const N8Y = [0, 0, 1, -1, 1, -1, 1, -1]

export type Segment = {
  id: number
  chain: number[]
  a: number
  b: number
  path?: string
  median?: Pt[]
}

// Zhang-Suen 세선화. 한 단계(step)의 삭제 후보는 전부 모은 뒤 한꺼번에 지운다(병렬 규칙).
// 잉크 픽셀만 담은 목록(active)을 따라가고, 이웃 8칸은 배열을 만들지 않고 지역 변수로 읽는다.
export function zhangSuen(src: Uint8Array, w: number, h: number): Uint8Array {
  const img = src.slice()
  let active: number[] = []
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      if (img[i]) active.push(i)
    }
  }
  const drop: number[] = []
  let changed = true
  while (changed) {
    changed = false
    for (let step = 0; step < 2; step++) {
      drop.length = 0
      for (const i of active) {
        // 이웃: 위, 오른쪽 위, 오른쪽, 오른쪽 아래, 아래, 왼쪽 아래, 왼쪽, 왼쪽 위(시계 방향)
        const p0 = img[i - w]
        const p1 = img[i - w + 1]
        const p2 = img[i + 1]
        const p3 = img[i + w + 1]
        const p4 = img[i + w]
        const p5 = img[i + w - 1]
        const p6 = img[i - 1]
        const p7 = img[i - w - 1]
        const bp = p0 + p1 + p2 + p3 + p4 + p5 + p6 + p7
        if (bp < 2 || bp > 6) continue
        // 0→1로 바뀌는 횟수(8방향 순환)
        const ap = (!p0 && p1 ? 1 : 0) + (!p1 && p2 ? 1 : 0) + (!p2 && p3 ? 1 : 0) + (!p3 && p4 ? 1 : 0)
          + (!p4 && p5 ? 1 : 0) + (!p5 && p6 ? 1 : 0) + (!p6 && p7 ? 1 : 0) + (!p7 && p0 ? 1 : 0)
        if (ap !== 1) continue
        if (step === 0) {
          if (p0 && p2 && p4) continue
          if (p2 && p4 && p6) continue
        } else {
          if (p0 && p2 && p6) continue
          if (p0 && p4 && p6) continue
        }
        drop.push(i)
      }
      if (drop.length) {
        changed = true
        for (const i of drop) img[i] = 0
        active = active.filter((i) => img[i])
      }
    }
  }
  return img
}

export function pruneSpurs(skeleton: Uint8Array, w: number, h: number) {
  for (let pass = 0; pass < SPUR_PASSES; pass++) {
    const deg = degrees(skeleton, w, h)
    let changed = false
    for (let i = 0; i < skeleton.length; i++) {
      if (!skeleton[i] || deg[i] !== 1) continue
      const chain = [i]
      let prev = -1
      let cur = i
      while (chain.length < SPUR_SCAN_LENGTH) {
        const next = skelNeighbors(skeleton, w, h, cur).find((pixel) => pixel !== prev)
        if (next === undefined) break
        chain.push(next)
        prev = cur
        cur = next
        if (deg[cur] !== 2) break
      }
      if (deg[cur] >= 3 && chain.length < SPUR_MAX_LENGTH) {
        for (const pixel of chain) if (pixel !== cur) skeleton[pixel] = 0
        changed = true
      }
    }
    if (!changed) break
  }
}

export function degrees(skeleton: Uint8Array, w: number, h: number): Uint8Array {
  const deg = new Uint8Array(w * h)
  for (let i = 0; i < skeleton.length; i++) {
    if (skeleton[i]) deg[i] = skelNeighbors(skeleton, w, h, i).length
  }
  return deg
}

export function buildSegments(skeleton: Uint8Array, deg: Uint8Array, w: number, h: number): Segment[] {
  const used = new Set<string>()
  const segments: Segment[] = []
  const nodes: number[] = []
  for (let i = 0; i < skeleton.length; i++) {
    if (skeleton[i] && deg[i] !== 2) nodes.push(i)
  }
  const push = (chain: number[]) => {
    if (chain.length < 2) return
    for (let i = 1; i < chain.length; i++) used.add(edgeKey(chain[i - 1], chain[i]))
    segments.push({ id: segments.length, chain, a: chain[0], b: chain[chain.length - 1] })
  }
  for (const node of nodes) {
    for (const next of skelNeighbors(skeleton, w, h, node)) {
      if (used.has(edgeKey(node, next))) continue
      const chain = [node]
      let prev = node
      let cur = next
      const seen = new Set([node])
      while (!seen.has(cur)) {
        chain.push(cur)
        seen.add(cur)
        if (deg[cur] !== 2) break
        const onward = skelNeighbors(skeleton, w, h, cur).find((pixel) => pixel !== prev)
        if (onward === undefined) break
        prev = cur
        cur = onward
      }
      push(chain)
    }
  }
  if (segments.length === 0) {
    const start = skeleton.findIndex((value) => value === 1)
    if (start >= 0) {
      const chain = [start]
      let prev = -1
      let cur = start
      for (let guard = 0; guard < skeleton.length; guard++) {
        const onward = skelNeighbors(skeleton, w, h, cur).find((pixel) => pixel !== prev && !chain.includes(pixel))
        if (onward === undefined) break
        prev = cur
        cur = onward
        chain.push(cur)
      }
      push(chain)
    }
  }
  return segments
}

function edgeKey(a: number, b: number): string {
  return a < b ? `${a},${b}` : `${b},${a}`
}

export function skelNeighbors(skeleton: Uint8Array, w: number, h: number, i: number): number[] {
  const x = i % w
  const y = (i / w) | 0
  const found: number[] = []
  for (let k = 0; k < 8; k++) {
    const nx = x + N8[k]
    const ny = y + N8Y[k]
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
    const ni = ny * w + nx
    if (skeleton[ni]) found.push(ni)
  }
  return found
}
