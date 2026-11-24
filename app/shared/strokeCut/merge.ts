import { flattenContours, pointSegmentDistance, polygonArea, type Pt } from '../paths.ts'
import { fitClosedLoop } from './curveFit.ts'

// 다른 윤곽(contour)에 걸쳐 있어 따로 떨어진 한 획의 조각들을 한 서브패스로 잇는다.
// 글꼴이 한 획을 겹치지 않는 윤곽 여럿으로 나눠 그렸거나 가운데를 다른 획이 덮으면, 한 획이 서로 마주 보는 조각으로 남는다.
// 마주 보는 변을 걷어내고 양쪽 끝을 이으면 사이 빈틈이 메워져 한 덩어리가 된다.
const MERGE_FLATNESS = 1.2
// 조각을 다시 찍는 간격(글꼴 좌표). 마주 보는 변에 점이 듬성하지 않게 한다.
const MERGE_STEP = 4
// 이어 붙인 뒤에도 각 조각에 남아야 하는 최소 점 수(변 전체가 마주 보면 잇지 않는다).
const MIN_REMAINING_POINTS = 3

function resampleLoop(loop: Pt[]): Pt[] {
  const ring = loop.length > 1 && loop[0].x === loop[loop.length - 1].x && loop[0].y === loop[loop.length - 1].y ? loop.slice(0, -1) : loop
  const out: Pt[] = []
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    out.push(a)
    const steps = Math.floor(Math.hypot(b.x - a.x, b.y - a.y) / MERGE_STEP)
    for (let k = 1; k < steps; k++) out.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps })
  }
  return out
}

function distanceToLoop(point: Pt, loop: Pt[]): number {
  let best = Infinity
  for (let i = 0; i < loop.length; i++) best = Math.min(best, pointSegmentDistance(point, loop[i], loop[(i + 1) % loop.length]))
  return best
}

function insideLoop(point: Pt, loop: Pt[]): boolean {
  let winding = 0
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % loop.length]
    if ((a.y <= point.y) !== (b.y <= point.y) && a.x + ((point.y - a.y) / (b.y - a.y)) * (b.x - a.x) > point.x) winding += b.y > a.y ? 1 : -1
  }
  return winding !== 0
}

// 한 바퀴 점열에서 표시된 점이 하나로 이어진 구간이면 [처음, 끝]을, 아니면(없거나 여러 토막이거나 전부이면) null을 돌려준다.
function singleRun(flags: boolean[]): [number, number] | null {
  const n = flags.length
  const starts = flags.map((flag, i) => (flag && !flags[(i - 1 + n) % n] ? i : -1)).filter((i) => i >= 0)
  if (starts.length !== 1) return null
  let end = starts[0]
  while (flags[(end + 1) % n]) end = (end + 1) % n
  return [starts[0], end]
}

function arcBetween(loop: Pt[], from: number, to: number): Pt[] {
  const out = [loop[from]]
  for (let i = from; i !== to; ) {
    i = (i + 1) % loop.length
    out.push(loop[i])
  }
  return out
}

// 두 조각(같은 방향으로 감긴 점열)을 마주 보는 변(상대에서 gap 이내인 구간)을 걷어내고 이어 한 점열로 만든다. 못 이으면 null.
function joinLoops(a: Pt[], b: Pt[], gap: number): Pt[] | null {
  if (a.some((point) => insideLoop(point, b)) || b.some((point) => insideLoop(point, a))) return null
  const runA = singleRun(a.map((point) => distanceToLoop(point, b) <= gap))
  const runB = singleRun(b.map((point) => distanceToLoop(point, a) <= gap))
  if (!runA || !runB) return null
  const [startA, endA] = runA
  const [startB, endB] = runB
  const keptA = arcBetween(a, endA, startA)
  const keptB = arcBetween(b, endB, startB)
  if (keptA.length < MIN_REMAINING_POINTS || keptB.length < MIN_REMAINING_POINTS) return null
  return [...keptA, ...keptB]
}

// 같은 방향으로 감긴 서브패스 가운데 서로 gap 이내로 마주 보는 것들을 하나로 잇는다. 구멍(반대 방향)과 잇지 못한 조각은 그대로 둔다.
export function mergeNearLoops(subpaths: string[], gap: number): string[] {
  if (subpaths.length < 2) return subpaths
  const loops = subpaths.map((subpath) => flattenContours(subpath, MERGE_FLATNESS)[0] ?? [])
  const areas = loops.map(polygonArea)
  const largest = areas.reduce((best, area) => (Math.abs(area) > Math.abs(best) ? area : best), 0)
  const order = subpaths.map((_, index) => index).sort((x, y) => Math.abs(areas[y]) - Math.abs(areas[x]))
  const absorbed = new Set<number>()
  const base = order.find((index) => Math.sign(areas[index]) === Math.sign(largest))
  if (base === undefined) return subpaths
  let current = resampleLoop(loops[base])
  let changed = false
  for (const index of order) {
    if (index === base || Math.sign(areas[index]) !== Math.sign(largest)) continue
    const joined = joinLoops(current, resampleLoop(loops[index]), gap)
    if (!joined) continue
    current = joined
    absorbed.add(index)
    changed = true
  }
  if (!changed) return subpaths
  const path = fitClosedLoop(current)
  if (!path) return subpaths
  return subpaths.flatMap((subpath, index) => (index === base ? [path] : absorbed.has(index) ? [] : [subpath]))
}
