import { parseCommands, round1 } from '../paths.ts'

// 윤곽 경로의 앵커(이웃한 두 세그먼트가 만나는 점)에서 접선이 조금 어긋난 곳을 매끄럽게 잇는다.
// 겹쳐 들어가는 끝 모양(strokeCut/overlap.ts)은 시작·끝 접선이 단면에 수직이지만, 이웃 윤곽 변은 수직이 아닐 수 있어
// 접합부에 20~40°쯤 꺾인 앵커가 생긴다. 진짜 모서리(MAX_JOIN_DEG 이상)와 직선끼리의 꺾임은 그대로 둔다.

// 이 각도(도) 이상 꺾인 앵커는 의도한 모서리라고 보고 건드리지 않는다. curveFit.ts의 모서리 판정과 같은 값이다.
const MAX_JOIN_DEG = 55
// 이 각도(도) 미만은 이미 매끄럽다고 본다.
const MIN_JOIN_DEG = 1
const RADIANS_TO_DEGREES = 180 / Math.PI
const DEGENERATE_LENGTH = 1e-6
// 2차 베지어를 3차로 올릴 때의 제어점 비율
const QUAD_TO_CUBIC = 2 / 3

type P = [number, number]
type Segment = { kind: 'L' | 'C'; from: P; c1: P; c2: P; to: P }
// 접선을 맞추기 전의 원래 제어점. 맞춘 곡선이 들어간 깊이를 원래대로 되돌리는 데 쓴다.
type Original = { c1: P; c2: P }

const sub = (a: P, b: P): P => [a[0] - b[0], a[1] - b[1]]
const length = (v: P): number => Math.hypot(v[0], v[1])
const scale = (v: P, k: number): P => [v[0] * k, v[1] * k]
const add = (a: P, b: P): P => [a[0] + b[0], a[1] + b[1]]

// 같은 서브패스를 이루는 세그먼트 목록으로 바꾼다. 2차 곡선은 3차로 올린다(모양은 같다).
function subpathsOf(d: string): { segments: Segment[]; closed: boolean }[] {
  const out: { segments: Segment[]; closed: boolean }[] = []
  let segments: Segment[] = []
  let cur: P = [0, 0]
  let start: P = [0, 0]
  const finish = (closed: boolean) => {
    if (segments.length > 0) out.push({ segments, closed })
    segments = []
  }
  for (const cmd of parseCommands(d)) {
    if (cmd.op === 'M') {
      finish(false)
      cur = [cmd.n[0], cmd.n[1]]
      start = cur
    } else if (cmd.op === 'L') {
      const to: P = [cmd.n[0], cmd.n[1]]
      segments.push({ kind: 'L', from: cur, c1: cur, c2: to, to })
      cur = to
    } else if (cmd.op === 'Q') {
      const q: P = [cmd.n[0], cmd.n[1]]
      const to: P = [cmd.n[2], cmd.n[3]]
      segments.push({ kind: 'C', from: cur, c1: add(cur, scale(sub(q, cur), QUAD_TO_CUBIC)), c2: add(to, scale(sub(q, to), QUAD_TO_CUBIC)), to })
      cur = to
    } else if (cmd.op === 'C') {
      const to: P = [cmd.n[4], cmd.n[5]]
      segments.push({ kind: 'C', from: cur, c1: [cmd.n[0], cmd.n[1]], c2: [cmd.n[2], cmd.n[3]], to })
      cur = to
    } else if (length(sub(cur, start)) > DEGENERATE_LENGTH) {
      segments.push({ kind: 'L', from: cur, c1: cur, c2: start, to: start })
      cur = start
      finish(true)
    } else {
      finish(true)
    }
  }
  finish(false)
  return out
}

// 세그먼트 끝으로 들어오는 방향과 다음 세그먼트에서 나가는 방향.
const incoming = (s: Segment): P => sub(s.to, s.kind === 'L' ? s.from : s.c2)
const outgoing = (s: Segment): P => sub(s.kind === 'L' ? s.to : s.c1, s.from)

function turnDeg(a: P, b: P): number {
  let turn = Math.abs(Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0]))
  if (turn > Math.PI) turn = 2 * Math.PI - turn
  return turn * RADIANS_TO_DEGREES
}

// 핸들 길이를 맞추는 배율의 탐색 범위와 이분 탐색 횟수
const MIN_HANDLE_SCALE = 0.4
const MAX_HANDLE_SCALE = 3
const SCALE_SEARCH_ROUNDS = 24
const EXTENT_SAMPLES = 24
// 깊이를 지킬 방향들: 들어간 방향을 기준으로 양옆으로 기울인 각(라디안)
const EXTENT_TILT = Math.PI / 12
const EXTENT_TILTS = [-EXTENT_TILT, 0, EXTENT_TILT]

const cubicAt = (s: Segment, c1: P, c2: P, t: number): P => {
  const m = 1 - t
  return [
    m * m * m * s.from[0] + 3 * m * m * t * c1[0] + 3 * m * t * t * c2[0] + t * t * t * s.to[0],
    m * m * m * s.from[1] + 3 * m * m * t * c1[1] + 3 * m * t * t * c2[1] + t * t * t * s.to[1],
  ]
}

const rotate = (v: P, angle: number): P => [
  v[0] * Math.cos(angle) - v[1] * Math.sin(angle),
  v[0] * Math.sin(angle) + v[1] * Math.cos(angle),
]

// 현(from→to)의 중점에서 dir 방향으로 곡선이 가장 멀리 나간 거리.
function extentAlong(s: Segment, c1: P, c2: P, dir: P): number {
  const mid: P = [(s.from[0] + s.to[0]) / 2, (s.from[1] + s.to[1]) / 2]
  let best = 0
  for (let i = 1; i < EXTENT_SAMPLES; i++) {
    const p = cubicAt(s, c1, c2, i / EXTENT_SAMPLES)
    best = Math.max(best, (p[0] - mid[0]) * dir[0] + (p[1] - mid[1]) * dir[1])
  }
  return best
}

// 원래 곡선의 한가운데(t=0.5) 점이 현의 중점에서 향하는 단위 방향(끝 모양이 들어간 방향).
function bulgeDirection(s: Segment, original: Original): P | null {
  const mid: P = [(s.from[0] + s.to[0]) / 2, (s.from[1] + s.to[1]) / 2]
  const offset = sub(cubicAt(s, original.c1, original.c2, 0.5), mid)
  const size = length(offset)
  return size < DEGENERATE_LENGTH ? null : scale(offset, 1 / size)
}

// 접선을 맞추느라 바뀐 곡선이 원래만큼만 나가도록 바뀐 핸들의 길이를 함께 늘이거나 줄인다.
// 끝 모양의 겹침 깊이(상대 획 폭 대비 비율 범위)가 접선을 맞춘 뒤에도 유지된다.
function restoreExtent(s: Segment, original: Original, changed: { c1: boolean; c2: boolean }): void {
  const apex = bulgeDirection(s, original)
  if (!apex) return
  // 끝 모양이 치우쳐 있어도 깊이가 줄지 않도록 들어간 방향과 그 양옆 방향을 모두 지킨다.
  const dirs = EXTENT_TILTS.map((tilt) => rotate(apex, tilt))
  const targets = dirs.map((dir) => extentAlong(s, original.c1, original.c2, dir))
  const withScale = (k: number): { c1: P; c2: P } => ({
    c1: changed.c1 ? add(s.from, scale(sub(s.c1, s.from), k)) : s.c1,
    c2: changed.c2 ? add(s.to, scale(sub(s.c2, s.to), k)) : s.c2,
  })
  const enough = (k: number): boolean => {
    const trial = withScale(k)
    return dirs.every((dir, i) => extentAlong(s, trial.c1, trial.c2, dir) >= targets[i])
  }
  let lo = MIN_HANDLE_SCALE
  let hi = MAX_HANDLE_SCALE
  for (let i = 0; i < SCALE_SEARCH_ROUNDS; i++) {
    const mid = (lo + hi) / 2
    if (enough(mid)) hi = mid
    else lo = mid
  }
  const fitted = withScale(hi)
  s.c1 = fitted.c1
  s.c2 = fitted.c2
}

// 앵커 접선이 MIN_JOIN_DEG~MAX_JOIN_DEG 어긋난 곳의 수. 매끄럽게 이을 대상을 센다.
export function mildJoinCount(d: string): number {
  let count = 0
  for (const { segments, closed } of subpathsOf(d)) {
    const last = closed ? segments.length : segments.length - 1
    for (let i = 0; i < last; i++) {
      const a = incoming(segments[i])
      const b = outgoing(segments[(i + 1) % segments.length])
      if (length(a) < DEGENERATE_LENGTH || length(b) < DEGENERATE_LENGTH) continue
      const deg = turnDeg(a, b)
      if (deg >= MIN_JOIN_DEG && deg < MAX_JOIN_DEG) count++
    }
  }
  return count
}

const fmt = (p: P): string => `${round1(p[0])} ${round1(p[1])}`

// 약하게 꺾인 앵커의 두 핸들을 같은 접선 방향으로 맞춘 경로. 한쪽이 직선이면 직선 방향을 따르고(직선은 그대로),
// 양쪽이 곡선이면 두 방향의 평균을 쓴다. 핸들 길이는 유지한다. 고칠 곳이 없으면 입력 문자열을 그대로 돌려준다.
export function smoothMildJoins(d: string): string {
  const subpaths = subpathsOf(d)
  let changed = false
  const touched = new Map<Segment, { original: Original; c1: boolean; c2: boolean }>()
  const touch = (seg: Segment, end: 'c1' | 'c2') => {
    const entry = touched.get(seg) ?? { original: { c1: seg.c1, c2: seg.c2 }, c1: false, c2: false }
    entry[end] = true
    touched.set(seg, entry)
  }
  for (const { segments, closed } of subpaths) {
    const last = closed ? segments.length : segments.length - 1
    for (let i = 0; i < last; i++) {
      const prev = segments[i]
      const next = segments[(i + 1) % segments.length]
      const a = incoming(prev)
      const b = outgoing(next)
      if (length(a) < DEGENERATE_LENGTH || length(b) < DEGENERATE_LENGTH) continue
      const deg = turnDeg(a, b)
      if (deg < MIN_JOIN_DEG || deg >= MAX_JOIN_DEG) continue
      if (prev.kind === 'L' && next.kind === 'L') continue
      const ua = scale(a, 1 / length(a))
      const ub = scale(b, 1 / length(b))
      const tangent: P = prev.kind === 'L' ? ua : next.kind === 'L' ? ub : (() => {
        const mean = add(ua, ub)
        return scale(mean, 1 / length(mean))
      })()
      if (prev.kind === 'C') {
        touch(prev, 'c2')
        prev.c2 = sub(prev.to, scale(tangent, length(a)))
      }
      if (next.kind === 'C') {
        touch(next, 'c1')
        next.c1 = add(next.from, scale(tangent, length(b)))
      }
      changed = true
    }
  }
  if (!changed) return d
  for (const [seg, entry] of touched) restoreExtent(seg, entry.original, entry)
  return subpaths
    .map(({ segments, closed }) => {
      const body = segments.map((s) => (s.kind === 'L' ? `L ${fmt(s.to)}` : `C ${fmt(s.c1)} ${fmt(s.c2)} ${fmt(s.to)}`))
      // 닫힌 경로는 마지막 선분(닫는 선)을 Z가 대신한다.
      const trimmed = closed && segments[segments.length - 1].kind === 'L' ? body.slice(0, -1) : body
      return `M ${fmt(segments[0].from)} ${trimmed.join(' ')}${closed ? ' Z' : ''}`
    })
    .join(' ')
}
