import assert from 'node:assert/strict'
import test from 'node:test'
import { samplePath } from '../shared/paths.ts'
import { segmentOutlineByMedians, spliceOutlineBridge } from '../shared/strokeCut.ts'

const PLUS = 'M 0 80 H 80 V 0 H 120 V 80 H 200 V 120 H 120 V 200 H 80 V 120 H 0 Z'

test('교차 획은 외곽선 끝점을 베지어로 잇고 상대 획의 줄기를 따라가지 않는다', () => {
  const split = segmentOutlineByMedians(
    [PLUS],
    [
      [{ x: 10, y: 100 }, { x: 190, y: 100 }],
      [{ x: 100, y: 10 }, { x: 100, y: 190 }],
    ],
    40,
  )
  const horizontal = samplePath(split.strokes[0], 1)
  const vertical = samplePath(split.strokes[1], 1)
  assert.match(split.strokes[0], /C /)
  assert.match(split.strokes[1], /C /)
  assert.ok(horizontal.every((p) => p.y > 60 && p.y < 140))
  assert.ok(vertical.every((p) => p.x > 60 && p.x < 140))
})

// 아래변이 교차에서 상대 획 옆면으로 내려갔다 돌아온다. 베지어는 그 옆면이 아니라 모서리에서 끝나야 한다.
const NOTCHED = 'M 0 120 L 300 120 L 300 80 L 180 80 L 180 50 L 120 50 L 120 80 L 0 80 Z'

test('교차에서 상대 획 옆면으로 내려간 윤곽은 모서리와 모서리를 직선으로 잇는다', () => {
  const split = segmentOutlineByMedians(
    [NOTCHED],
    [
      [{ x: 0, y: 100 }, { x: 300, y: 100 }],
      [{ x: 150, y: 0 }, { x: 150, y: 200 }],
    ],
  )
  const horizontal = samplePath(split.strokes[0], 1)
  const across = horizontal.filter((p) => p.x >= 120 && p.x <= 180)
  assert.ok(across.length > 0)
  assert.ok(across.every((p) => p.y >= 78))
})

test('찍은 두 끝점 사이의 짧은 윤곽만 베지어로 바뀐다', () => {
  const rect = 'M 0 0 L 100 0 L 100 40 L 0 40 Z'
  const path = spliceOutlineBridge(rect, [{ x: 0, y: 10 }, { x: 30, y: 0 }, { x: 0, y: 30 }])
  assert.ok(path)
  assert.match(path, /C /)
  const points = samplePath(path, 1)
  assert.ok(points.some((p) => p.x > 90))
  assert.equal(spliceOutlineBridge(rect, [{ x: 0, y: 10 }]), null)
})

const OVERLAP_RANGE = { min: 0.5, max: 2 / 3 }

test('T자 접합부 끝단 겹침(브릿지): 옆면은 평탄 유지, 세로획 윗끝은 상대 폭의 1/2~2/3 겹침', () => {
  const tShape = 'M 0 300 L 300 300 L 300 200 L 180 200 L 180 0 L 120 0 L 120 200 L 0 200 Z'
  const split = segmentOutlineByMedians(
    [tShape],
    [
      [{ x: 10, y: 250 }, { x: 290, y: 250 }],
      [{ x: 150, y: 195 }, { x: 150, y: 10 }],
    ],
    135,
    { endOverlap: OVERLAP_RANGE },
  )
  const horizontal = samplePath(split.strokes[0], 1)
  const vertical = samplePath(split.strokes[1], 1)
  assert.ok(horizontal.every((p) => p.y >= 198 && p.y <= 301))
  const maxY = Math.max(...vertical.map((p) => p.y))
  assert.ok(maxY >= 249 && maxY <= 268, `T자 세로획 윗끝 겹침 범위 이탈: maxY=${maxY}`)
  assert.ok(vertical.every((p) => p.x >= 119 && p.x <= 181 && p.y <= 300))
})

test('양끝 T자(工 형태): 위·아래 상대 획 폭이 다르면 각 폭의 1/2~2/3로 비례 겹침', () => {
  // 상단 가로획 y∈[220,300](폭 80), 하단 가로획 y∈[0,120](폭 120), 중앙 세로획 x∈[120,180]
  const iShape = 'M 0 300 L 300 300 L 300 220 L 180 220 L 180 120 L 300 120 L 300 0 L 0 0 L 0 120 L 120 120 L 120 220 L 0 220 Z'
  const split = segmentOutlineByMedians(
    [iShape],
    [
      [{ x: 10, y: 260 }, { x: 290, y: 260 }],
      [{ x: 150, y: 215 }, { x: 150, y: 125 }],
      [{ x: 10, y: 60 }, { x: 290, y: 60 }],
    ],
    135,
    { endOverlap: OVERLAP_RANGE },
  )
  const stem = samplePath(split.strokes[1], 1)
  const maxY = Math.max(...stem.map((p) => p.y))
  const minY = Math.min(...stem.map((p) => p.y))
  const topOverlap = maxY - 220
  const bottomOverlap = 120 - minY
  assert.ok(topOverlap >= 39 && topOverlap <= 55, `상단(폭 80) 겹침 이탈: ${topOverlap}`)
  assert.ok(bottomOverlap >= 58 && bottomOverlap <= 82, `하단(폭 120) 겹침 이탈: ${bottomOverlap}`)
  assert.ok(bottomOverlap > topOverlap, `하단 폭(120) 겹침이 상단 폭(80)보다 커야 함: ${bottomOverlap} vs ${topOverlap}`)
})

test('교차 통과(十) 획은 endOverlap 옵션에서도 불필요하게 돌출되지 않는다', () => {
  const split = segmentOutlineByMedians(
    [PLUS],
    [
      [{ x: 10, y: 100 }, { x: 190, y: 100 }],
      [{ x: 100, y: 10 }, { x: 100, y: 190 }],
    ],
    40,
    { endOverlap: OVERLAP_RANGE },
  )
  const horizontal = samplePath(split.strokes[0], 1)
  const vertical = samplePath(split.strokes[1], 1)
  assert.ok(horizontal.every((p) => p.y > 60 && p.y < 140))
  assert.ok(vertical.every((p) => p.x > 60 && p.x < 140))
})

test('래스터 폴백(口 유사 구멍 포함 윤곽)에서도 가로획 양끝이 좌·우 획 안으로 1/2~2/3 겹친다', () => {
  // 바깥 [0,450]x[0,450], 안쪽 구멍 [100,350]x[100,350] -> 좌·우·상·하 각 변의 폭 100
  const boxWithHole = 'M 0 0 L 450 0 L 450 450 L 0 450 Z M 100 100 L 100 350 L 350 350 L 350 100 Z'
  const split = segmentOutlineByMedians(
    [boxWithHole],
    [
      [{ x: 50, y: 400 }, { x: 50, y: 40 }],
      [{ x: 100, y: 400 }, { x: 400, y: 400 }, { x: 400, y: 40 }],
      [{ x: 105, y: 50 }, { x: 345, y: 50 }],
    ],
    100,
    { endOverlap: OVERLAP_RANGE },
  )
  const bottom = samplePath(split.strokes[2], 1)
  const minX = Math.min(...bottom.map((p) => p.x))
  const maxX = Math.max(...bottom.map((p) => p.x))
  const leftOverlap = 100 - minX
  const rightOverlap = maxX - 350
  assert.ok(leftOverlap >= 45 && leftOverlap <= 70, `왼쪽 겹침 이탈: ${leftOverlap} (minX=${minX})`)
  assert.ok(rightOverlap >= 45 && rightOverlap <= 70, `오른쪽 겹침 이탈: ${rightOverlap} (maxX=${maxX})`)
  assert.ok(bottom.every((p) => p.x >= -1 && p.x <= 451 && p.y >= -1 && p.y <= 105))
})
