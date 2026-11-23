import { round1, type Pt } from '../paths.ts'

// 래스터에서 얻은 계단 모양 윤곽(닫힌 점열)을 모서리는 살리고 나머지는 부드러운 3차 베지어로 맞춘다(Schneider 방식).
// 사람이 쓴 획은 곡선 몇 개로 이뤄지므로, 정점 수백 개짜리 직선 경로보다 형태가 자연스럽고 변곡점 잡음이 없다.

// 맞춤 허용 오차(글꼴 좌표). 점열이 곡선에서 이만큼 넘게 벗어나면 곡선을 나눈다.
const FIT_TOLERANCE = 1.5
// 직선으로 볼 수 있는 최대 편차(글꼴 좌표). 곡선 허용 오차보다 엄격해야 긴 직선 변이 곡선으로 부풀지 않는다.
const STRAIGHT_TOLERANCE = 1
// 모서리 판정: 앞뒤 CORNER_WINDOW(글꼴 좌표 길이) 떨어진 점으로 잰 꺾임이 이 각도(도)를 넘으면 모서리 후보다.
const CORNER_ANGLE_DEG = 55
const CORNER_WINDOW = 10
// 곡선 맞춤에서 매개변수를 다시 구하는(Newton) 최대 횟수
const REPARAMETERIZE_ROUNDS = 4
// 끝 접선을 구할 때 끝에서 이만큼(글꼴 좌표 길이) 안쪽 점까지 본다.
const TANGENT_REACH = 6
const MIN_SEGMENT_POINTS = 2
const RADIANS_TO_DEGREES = 180 / Math.PI
const EPSILON = 1e-9

type Bezier = [Pt, Pt, Pt, Pt]

const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y })
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const scale = (a: Pt, k: number): Pt => ({ x: a.x * k, y: a.y * k })
const dot = (a: Pt, b: Pt): number => a.x * b.x + a.y * b.y
const length = (a: Pt): number => Math.hypot(a.x, a.y)
const unit = (a: Pt): Pt => {
  const size = length(a)
  return size < EPSILON ? { x: 0, y: 0 } : scale(a, 1 / size)
}

function bezierAt(curve: Bezier, t: number): Pt {
  const u = 1 - t
  return add(add(scale(curve[0], u * u * u), scale(curve[1], 3 * u * u * t)), add(scale(curve[2], 3 * u * t * t), scale(curve[3], t * t * t)))
}
function derivative1(curve: Bezier, t: number): Pt {
  const u = 1 - t
  return add(add(scale(sub(curve[1], curve[0]), 3 * u * u), scale(sub(curve[2], curve[1]), 6 * u * t)), scale(sub(curve[3], curve[2]), 3 * t * t))
}
function derivative2(curve: Bezier, t: number): Pt {
  const u = 1 - t
  return add(scale(add(sub(curve[2], scale(curve[1], 2)), curve[0]), 6 * u), scale(add(sub(curve[3], scale(curve[2], 2)), curve[1]), 6 * t))
}

function chordParameters(points: Pt[]): number[] {
  const params = [0]
  for (let i = 1; i < points.length; i++) params.push(params[i - 1] + length(sub(points[i], points[i - 1])))
  const total = params[params.length - 1]
  return total < EPSILON ? params.map((_, i) => i / (points.length - 1)) : params.map((value) => value / total)
}

// 끝 접선(바깥쪽에서 안쪽으로 향하는 단위 벡터)을 TANGENT_REACH 안쪽 점으로 잰다.
function startTangent(points: Pt[]): Pt {
  let reach = 1
  while (reach < points.length - 1 && length(sub(points[reach], points[0])) < TANGENT_REACH) reach++
  return unit(sub(points[reach], points[0]))
}
function endTangent(points: Pt[]): Pt {
  const last = points.length - 1
  let reach = last - 1
  while (reach > 0 && length(sub(points[reach], points[last])) < TANGENT_REACH) reach--
  return unit(sub(points[reach], points[last]))
}

// 접선 방향이 주어진 3차 베지어를 최소제곱으로 맞춘다. 퇴화하면 끝점 거리의 1/3로 대체한다.
function generateBezier(points: Pt[], params: number[], tan1: Pt, tan2: Pt): Bezier {
  const first = points[0]
  const last = points[points.length - 1]
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0
  for (let i = 0; i < points.length; i++) {
    const t = params[i]
    const u = 1 - t
    const b0 = u * u * u, b1 = 3 * u * u * t, b2 = 3 * u * t * t, b3 = t * t * t
    const a1 = scale(tan1, b1)
    const a2 = scale(tan2, b2)
    c00 += dot(a1, a1)
    c01 += dot(a1, a2)
    c11 += dot(a2, a2)
    const rest = sub(points[i], add(scale(first, b0 + b1), scale(last, b2 + b3)))
    x0 += dot(a1, rest)
    x1 += dot(a2, rest)
  }
  const det = c00 * c11 - c01 * c01
  const chord = length(sub(last, first))
  let alpha1 = Math.abs(det) > EPSILON ? (x0 * c11 - x1 * c01) / det : 0
  let alpha2 = Math.abs(det) > EPSILON ? (c00 * x1 - c01 * x0) / det : 0
  // 음수이거나 지나치게 길면 모양이 뒤집힌다: 끝점 거리의 1/3을 쓴다.
  if (alpha1 < chord * 1e-3 || alpha2 < chord * 1e-3 || alpha1 > chord * 2 || alpha2 > chord * 2) {
    alpha1 = chord / 3
    alpha2 = chord / 3
  }
  return [first, add(first, scale(tan1, alpha1)), add(last, scale(tan2, alpha2)), last]
}

function newtonParameter(curve: Bezier, point: Pt, t: number): number {
  const diff = sub(bezierAt(curve, t), point)
  const d1 = derivative1(curve, t)
  const d2 = derivative2(curve, t)
  const denominator = dot(d1, d1) + dot(diff, d2)
  return Math.abs(denominator) < EPSILON ? t : Math.min(1, Math.max(0, t - dot(diff, d1) / denominator))
}

function maxError(points: Pt[], curve: Bezier, params: number[]): { error: number; index: number } {
  let error = 0
  let index = Math.floor(points.length / 2)
  for (let i = 1; i < points.length - 1; i++) {
    const distance = length(sub(bezierAt(curve, params[i]), points[i]))
    if (distance > error) {
      error = distance
      index = i
    }
  }
  return { error, index }
}

// 열린 점열 하나를 베지어 여러 개로 맞춘다. tan1은 시작점에서, tan2는 끝점에서 안쪽을 향한다.
function fitCubic(points: Pt[], tan1: Pt, tan2: Pt, tolerance: number): Bezier[] {
  if (points.length === MIN_SEGMENT_POINTS) {
    const gap = length(sub(points[1], points[0])) / 3
    return [[points[0], add(points[0], scale(tan1, gap)), add(points[1], scale(tan2, gap)), points[1]]]
  }
  let params = chordParameters(points)
  let curve = generateBezier(points, params, tan1, tan2)
  let { error, index } = maxError(points, curve, params)
  for (let round = 0; round < REPARAMETERIZE_ROUNDS && error >= tolerance; round++) {
    params = params.map((t, i) => newtonParameter(curve, points[i], t))
    curve = generateBezier(points, params, tan1, tan2)
    ;({ error, index } = maxError(points, curve, params))
  }
  if (error < tolerance) return [curve]
  const center = unit(sub(points[index - 1], points[index + 1]))
  return [
    ...fitCubic(points.slice(0, index + 1), tan1, center, tolerance),
    ...fitCubic(points.slice(index), scale(center, -1), tan2, tolerance),
  ]
}

function distanceToChord(point: Pt, a: Pt, b: Pt): number {
  const chord = sub(b, a)
  const size = length(chord)
  if (size < EPSILON) return length(sub(point, a))
  return Math.abs(chord.x * (point.y - a.y) - chord.y * (point.x - a.x)) / size
}

// 모서리(점열 번호)를 찾는다: 앞뒤 CORNER_WINDOW 떨어진 점으로 잰 꺾임이 기준을 넘고 이웃 중 가장 큰 곳.
// closed가 아니면 열린 점열이라 양 끝은 모서리 후보에서 뺀다(구간 끝이므로 어차피 나뉜다).
function findCorners(ring: Pt[], closed = true): number[] {
  const n = ring.length
  const angles = new Array<number>(n).fill(0)
  const at = (index: number) => (closed ? ring[((index % n) + n) % n] : ring[Math.min(n - 1, Math.max(0, index))])
  for (let i = closed ? 0 : 1; i < (closed ? n : n - 1); i++) {
    let back = i
    let travelled = 0
    while (travelled < CORNER_WINDOW && (closed ? i - back > -n : back > 0)) {
      travelled += length(sub(at(back), at(back - 1)))
      back--
    }
    let ahead = i
    travelled = 0
    while (travelled < CORNER_WINDOW && (closed ? ahead - i < n : ahead < n - 1)) {
      travelled += length(sub(at(ahead + 1), at(ahead)))
      ahead++
    }
    const before = sub(at(i), at(back))
    const after = sub(at(ahead), at(i))
    const size = length(before) * length(after)
    angles[i] = size < EPSILON ? 0 : Math.acos(Math.max(-1, Math.min(1, dot(before, after) / size))) * RADIANS_TO_DEGREES
  }
  const corners: number[] = []
  for (let i = 0; i < n; i++) {
    if (angles[i] <= CORNER_ANGLE_DEG) continue
    // 같은 모서리를 이루는 이웃 점들 중 가장 큰 점만 남긴다.
    let isPeak = true
    for (let k = 1; k < n && isPeak; k++) {
      const neighbor = closed ? (i + k) % n : i + k
      if (neighbor >= n) break
      const gap = length(sub(at(neighbor), at(i)))
      if (gap > CORNER_WINDOW) break
      if (angles[neighbor] > angles[i] || (angles[neighbor] === angles[i] && neighbor < i)) isPeak = false
    }
    for (let k = 1; k < n && isPeak; k++) {
      const neighbor = closed ? (i - k + n) % n : i - k
      if (neighbor < 0) break
      if (length(sub(at(neighbor), at(i))) > CORNER_WINDOW) break
      if (angles[neighbor] > angles[i] || (angles[neighbor] === angles[i] && neighbor < i)) isPeak = false
    }
    if (isPeak) corners.push(i)
  }
  return corners
}

function pointText(point: Pt): string {
  return `${round1(point.x)} ${round1(point.y)}`
}

// 한 구간(모서리~모서리)의 점열을 경로 명령으로 만든다. 거의 직선이면 L 하나로 줄인다.
function segmentCommands(points: Pt[], startTangentOverride: Pt | null, endTangentOverride: Pt | null): string {
  const chordA = points[0]
  const chordB = points[points.length - 1]
  const straight = points.every((point) => distanceToChord(point, chordA, chordB) < STRAIGHT_TOLERANCE)
  if (straight) return `L${pointText(chordB)}`
  const curves = fitCubic(points, startTangentOverride ?? startTangent(points), endTangentOverride ?? endTangent(points), FIT_TOLERANCE)
  return curves.map((curve) => `C${pointText(curve[1])} ${pointText(curve[2])} ${pointText(curve[3])}`).join('')
}

// 열린 점열을 첫 점에서 끝 점까지 이어지는 `L/C …` 명령으로 맞춘다(첫 점의 M은 호출한 쪽이 쓴다). 모서리는 살린다.
export function fitOpenPolyline(points: Pt[]): string {
  if (points.length < MIN_SEGMENT_POINTS + 1) return points.slice(1).map((point) => `L${pointText(point)}`).join('')
  const cuts = [0, ...findCorners(points, false), points.length - 1]
  let d = ''
  for (let c = 0; c < cuts.length - 1; c++) d += segmentCommands(points.slice(cuts[c], cuts[c + 1] + 1), null, null)
  return d
}

// 닫힌 점열(첫 점을 끝에 반복하지 않음)을 `M … C/L … Z` 경로로 만든다. 점이 모자라면 null.
export function fitClosedLoop(ring: Pt[]): string | null {
  if (ring.length < 3) return null
  const n = ring.length
  const corners = findCorners(ring)
  // 모서리가 없는 매끈한 고리는 가장 멀리 떨어진 두 곳에서 나눠 곡선 두 구간으로 맞춘다.
  const cuts = corners.length > 0 ? corners : [0, Math.floor(n / 2)]
  const smoothCut = corners.length === 0
  let d = `M${pointText(ring[cuts[0]])}`
  for (let c = 0; c < cuts.length; c++) {
    const from = cuts[c]
    const to = cuts[(c + 1) % cuts.length]
    const points: Pt[] = []
    for (let i = from; ; i = (i + 1) % n) {
      points.push(ring[i])
      if (i === to && points.length > 1) break
      if (points.length > n + 1) break
    }
    if (points.length < MIN_SEGMENT_POINTS) continue
    // 매끈한 분할점에서는 앞뒤 구간이 같은 접선을 공유하도록 이웃 점으로 접선을 정한다.
    const before = smoothCut ? unit(sub(ring[(from + 1) % n], ring[(from - 1 + n) % n])) : null
    const after = smoothCut ? unit(sub(ring[(to - 1 + n) % n], ring[(to + 1) % n])) : null
    d += segmentCommands(points, before, after)
  }
  return `${d}Z`
}
