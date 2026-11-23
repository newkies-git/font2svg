import type { Pt } from './types.ts'

// 획순은 NAVER가, 획의 모양(굵기·시작·끝·꺾임)은 Hanzi(MMH)가 기준이다. 두 출처는 같은 글자라도 폰트가 달라 좌표가 다르므로,
// 글자 전체 bbox로 정규화한 뒤 NAVER의 i번째 획에 가장 닮은 MMH 획을 짝지어(최소 비용 배정) 모양 쪽 획을 NAVER 순서로 늘어놓는다.
// 획 수가 다르면 짝지을 수 없으므로 null이다(호출한 쪽이 NAVER를 그대로 쓴다).
const NORMALIZED_SIZE = 1000
const EMPTY_BOX = 1

type Box = { minX: number; minY: number; width: number; height: number }

function boxOf(lines: Pt[][]): Box {
  const points = lines.flat()
  const xs = points.map(([x]) => x)
  const ys = points.map(([, y]) => y)
  const minX = Math.min(...xs)
  const minY = Math.min(...ys)
  return { minX, minY, width: Math.max(EMPTY_BOX, Math.max(...xs) - minX), height: Math.max(EMPTY_BOX, Math.max(...ys) - minY) }
}

// 획의 시작·가운데·끝 점을 글자 bbox 기준 0~NORMALIZED_SIZE로 옮긴 것(방향을 반영하므로 거꾸로 그린 획은 멀어진다).
function signature(line: Pt[], box: Box): Pt[] {
  const pick = (point: Pt): Pt => [((point[0] - box.minX) / box.width) * NORMALIZED_SIZE, ((point[1] - box.minY) / box.height) * NORMALIZED_SIZE]
  return [line[0], line[Math.floor(line.length / 2)], line[line.length - 1]].map(pick)
}

const distance = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1])

// 최소 비용 배정(헝가리 알고리즘, 획 수가 작아 O(n³)로 충분). 결과 result[i] = 행 i에 배정된 열.
function minCostAssignment(cost: number[][]): number[] {
  const n = cost.length
  const u = new Array<number>(n + 1).fill(0)
  const v = new Array<number>(n + 1).fill(0)
  const matched = new Array<number>(n + 1).fill(0)
  const way = new Array<number>(n + 1).fill(0)
  for (let row = 1; row <= n; row++) {
    matched[0] = row
    let col0 = 0
    const minv = new Array<number>(n + 1).fill(Infinity)
    const used = new Array<boolean>(n + 1).fill(false)
    do {
      used[col0] = true
      const row0 = matched[col0]
      let delta = Infinity
      let col1 = 0
      for (let col = 1; col <= n; col++) {
        if (used[col]) continue
        const current = cost[row0 - 1][col - 1] - u[row0] - v[col]
        if (current < minv[col]) {
          minv[col] = current
          way[col] = col0
        }
        if (minv[col] < delta) {
          delta = minv[col]
          col1 = col
        }
      }
      for (let col = 0; col <= n; col++) {
        if (used[col]) {
          u[matched[col]] += delta
          v[col] -= delta
        } else {
          minv[col] -= delta
        }
      }
      col0 = col1
    } while (matched[col0] !== 0)
    do {
      const col1 = way[col0]
      matched[col0] = matched[col1]
      col0 = col1
    } while (col0 !== 0)
  }
  const result = new Array<number>(n).fill(0)
  for (let col = 1; col <= n; col++) result[matched[col] - 1] = col - 1
  return result
}

// orderMedians(NAVER, 획순 기준)의 i번째 획에 대응하는 shapeMedians(MMH, 모양 기준)의 획 번호를 돌려준다. 짝지을 수 없으면 null.
export function matchStrokeOrder(orderMedians: Pt[][], shapeMedians: Pt[][]): number[] | null {
  const count = orderMedians.length
  if (count === 0 || count !== shapeMedians.length) return null
  if (orderMedians.some((line) => line.length === 0) || shapeMedians.some((line) => line.length === 0)) return null
  const orderBox = boxOf(orderMedians)
  const shapeBox = boxOf(shapeMedians)
  const orderSignatures = orderMedians.map((line) => signature(line, orderBox))
  const shapeSignatures = shapeMedians.map((line) => signature(line, shapeBox))
  const cost = orderSignatures.map((a) => shapeSignatures.map((b) => a.reduce((sum, point, index) => sum + distance(point, b[index]), 0)))
  return minCostAssignment(cost)
}

// matchStrokeOrder의 결과로 모양 쪽 목록을 획순대로 다시 늘어놓는다.
export function reorderByMatch<T>(shape: readonly T[], match: readonly number[]): T[] {
  return match.map((index) => shape[index])
}
