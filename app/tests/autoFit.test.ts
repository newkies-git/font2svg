import assert from 'node:assert/strict'
import test from 'node:test'
import { flattenContours, samplePath } from '../shared/paths.ts'
import { autoFitLayer, autoFitStroke } from '../src/lib/autoFit.ts'
import { transformStroke } from '../shared/vectorEdit.ts'
import { mildJoinCount } from '../shared/strokeCut/smoothJoins.ts'
import { rectPath, strokeOf } from './helpers.ts'

// 글자: 서로 떨어진 두 덩어리. 획: 같은 모양인데 위치·각도가 틀어진 레이어.
const fontPaths = [rectPath(150, 150, 450, 450), rectPath(550, 550, 850, 850)]
const exact = [
  strokeOf(rectPath(150, 150, 450, 450), [[160, 300], [440, 300]], { stroke_order: 1 }),
  strokeOf(rectPath(550, 550, 850, 850), [[560, 700], [840, 700]], { stroke_order: 2 }),
]

function shake(strokes = exact) {
  const rad = (6 * Math.PI) / 180
  return strokes.map((stroke) => transformStroke(stroke, (x, y) => {
    const dx = x - 500
    const dy = y - 500
    return [500 + dx * Math.cos(rad) - dy * Math.sin(rad) + 28, 500 + dx * Math.sin(rad) + dy * Math.cos(rad) - 22]
  }, 1))
}

test('레이어 전체 자동 맞춤은 겹침 비율을 크게 올린다', () => {
  const result = autoFitLayer(shake(), fontPaths)
  assert.ok(result.after > result.before, `${result.before} → ${result.after}`)
  assert.ok(result.after > 0.85, `맞춤 후 ${result.after}`)
  assert.equal(result.strokes.length, 2)
})

test('이미 맞는 레이어는 나빠지지 않는다', () => {
  const result = autoFitLayer(exact, fontPaths)
  assert.ok(result.after >= result.before - 1e-9)
  assert.ok(result.after > 0.95)
})

test('단일 획 맞춤은 선택한 획만 바꾼다', () => {
  const shaken = shake()
  const result = autoFitStroke(shaken, fontPaths, 0)
  assert.ok(result.after > result.before)
  assert.deepEqual(result.strokes[1], shaken[1])
})

test('단일 획은 궁서체 윤곽 그대로가 되고, 굽은 곳에는 중심선 점이 생긴다', () => {
  const font = ['M 80 340 C 300 340 400 360 500 400 C 600 440 700 340 920 340 L 920 430 C 700 430 600 530 500 530 C 400 530 300 430 80 430 Z']
  const ribbon = strokeOf(rectPath(80, 350, 920, 430), [[100, 390], [900, 390]])
  const result = autoFitStroke([ribbon], font, 0)
  assert.equal(result.strokes[0].outline_path, font[0])
  assert.ok(result.after > result.before)
  const bend = result.strokes[0].median_points.some(([, y]) => y > 430)
  assert.ok(bend, `중심선이 활을 따르지 않음: ${JSON.stringify(result.strokes[0].median_points)}`)
})

test('원본 획 배열은 바꾸지 않는다(불변)', () => {
  const shaken = shake()
  const snapshot = JSON.stringify(shaken)
  autoFitLayer(shaken, fontPaths)
  assert.equal(JSON.stringify(shaken), snapshot)
})

// ---- 구간/누적합 IoU가 칸 마스크 IoU와 같은 값을 내는지(차분 테스트) ----
import { fillMask, iou, iouSpans, spansOf, targetOf } from '../src/lib/autoFit.ts'

function rng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// 서로 겹치기도 하고 방향도 제각각인 무작위 다각형 몇 개
function randomLoops(seed: number) {
  const random = rng(seed)
  return Array.from({ length: 1 + Math.floor(random() * 4) }, () => {
    const cx = 100 + random() * 800
    const cy = 100 + random() * 800
    const radius = 30 + random() * 250
    const count = 3 + Math.floor(random() * 9)
    const direction = random() < 0.5 ? 1 : -1
    return Array.from({ length: count }, (_, k) => {
      const angle = (direction * 2 * Math.PI * k) / count + random() * 0.4
      return { x: cx + Math.cos(angle) * radius * (0.5 + random()), y: cy + Math.sin(angle) * radius * (0.5 + random()) }
    })
  })
}

test('구간 IoU는 칸 마스크 IoU와 같다(무작위 다각형 60쌍)', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const shape = randomLoops(seed)
    const targetShape = randomLoops(seed + 1000)
    const mask = fillMask(targetShape)
    const expected = iou(fillMask(shape), mask)
    const actual = iouSpans(spansOf(shape), targetOf(mask))
    assert.ok(Math.abs(expected - actual) < 1e-12, `seed ${seed}: ${expected} vs ${actual}`)
  }
})

test('구간은 행마다 겹치지 않고 정렬되어 있다', () => {
  for (let seed = 1; seed <= 30; seed++) {
    for (const row of spansOf(randomLoops(seed))) {
      for (let k = 0; k < row.length; k += 2) {
        assert.ok(row[k] <= row[k + 1])
        if (k >= 2) assert.ok(row[k] > row[k - 1], '앞 구간과 겹침')
      }
    }
  }
})

test('빈 도형·빈 목표의 IoU는 0', () => {
  assert.equal(iouSpans(spansOf([]), targetOf(new Uint8Array(256 * 256))), 0)
})

function pointInLoop(x: number, y: number, loop: { x: number; y: number }[]): boolean {
  let inside = false
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i]
    const b = loop[j]
    const onEdge = Math.abs((b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x)) <= 1e-3 * Math.hypot(b.x - a.x, b.y - a.y)
      && x >= Math.min(a.x, b.x) - 1 && x <= Math.max(a.x, b.x) + 1
      && y >= Math.min(a.y, b.y) - 1 && y <= Math.max(a.y, b.y) + 1
    if (onEdge) return true
    if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function allPointsInsideFont(path: string, fontPath: string): boolean {
  const loop = flattenContours(fontPath, 1)[0]
  return samplePath(path, 2).every((pt) => {
    for (let dx = -2; dx <= 2; dx += 2) {
      for (let dy = -2; dy <= 2; dy += 2) {
        if (pointInLoop(pt.x + dx, pt.y + dy, loop)) return true
      }
    }
    return false
  })
}

const T_FONT = ['M 100 700 L 900 700 L 900 600 L 550 600 L 550 100 L 450 100 L 450 600 L 100 600 Z']
const T_BAR = strokeOf(rectPath(100, 600, 900, 700), [[120, 650], [880, 650]], { stroke_order: 1 })
const T_STEM = strokeOf(rectPath(450, 100, 550, 600), [[500, 580], [500, 120]], { stroke_order: 2 })

test('자동 맞춤(레이어 전체): T자 단면 세로획이 가로획 폭의 1/2~2/3만큼 겹치고 궁서체 밖에 나가지 않는다', () => {
  const result = autoFitLayer([T_BAR, T_STEM], T_FONT)
  assert.ok(result.after > result.before, `${result.before} → ${result.after}`)
  const stemPts = samplePath(result.strokes[1].outline_path, 1)
  const barPts = samplePath(result.strokes[0].outline_path, 1)
  const maxY = Math.max(...stemPts.map((p) => p.y))
  assert.ok(maxY >= 648 && maxY <= 669, `세로획 윗끝 겹침 이탈: maxY=${maxY}`)
  assert.ok(barPts.every((p) => p.y >= 598), '가로획 아랫면은 평탄 유지')
  assert.ok(allPointsInsideFont(result.strokes[0].outline_path, T_FONT[0]))
  assert.ok(allPointsInsideFont(result.strokes[1].outline_path, T_FONT[0]))
})

test('자동 맞춤(단일 획): 선택한 세로획만 1/2~2/3 겹침으로 바뀌고 가로획은 그대로다', () => {
  const result = autoFitStroke([T_BAR, T_STEM], T_FONT, 1)
  assert.ok(result.after > result.before)
  assert.deepEqual(result.strokes[0], T_BAR)
  const maxY = Math.max(...samplePath(result.strokes[1].outline_path, 1).map((p) => p.y))
  assert.ok(maxY >= 648 && maxY <= 669, `단일 획 세로획 겹침 이탈: maxY=${maxY}`)
  assert.ok(allPointsInsideFont(result.strokes[1].outline_path, T_FONT[0]))
})

test('자동 맞춤(사선 접합부): 45° 획의 시작이 세로획 폭의 1/2~2/3만큼 겹치고 윤곽 밖으로 나가지 않는다', () => {
  const diagFont = ['M 200 900 L 300 900 L 300 600 L 650 250 L 570 170 L 300 440 L 300 100 L 200 100 Z']
  const vBar = strokeOf(rectPath(200, 100, 300, 900), [[250, 880], [250, 120]], { stroke_order: 1 })
  const diag = strokeOf('M 300 600 L 650 250 L 570 170 L 300 440 Z', [[320, 500], [600, 220]], { stroke_order: 2 })
  const result = autoFitLayer([vBar, diag], diagFont)
  assert.ok(result.after > result.before, `${result.before} → ${result.after}`)
  const diagPts = samplePath(result.strokes[1].outline_path, 1)
  const minX = Math.min(...diagPts.map((p) => p.x))
  const overlap = 300 - minX
  assert.ok(overlap >= 48 && overlap <= 69, `사선 획 겹침 이탈: overlap=${overlap} (minX=${minX})`)
  assert.ok(allPointsInsideFont(result.strokes[1].outline_path, diagFont[0]))
})

test('자동 맞춤 멱등성: 이미 맞춤된 T자에 다시 적용해도 겹침 깊이가 1/2~2/3를 넘지 않는다', () => {
  const first = autoFitLayer([T_BAR, T_STEM], T_FONT)
  const maxY1 = Math.max(...samplePath(first.strokes[1].outline_path, 1).map((p) => p.y))
  const second = autoFitLayer(first.strokes, T_FONT)
  const maxY2 = Math.max(...samplePath(second.strokes[1].outline_path, 1).map((p) => p.y))
  assert.ok(maxY2 >= 648 && maxY2 <= 669, `재적용 후 겹침 범위 이탈: maxY2=${maxY2}`)
  assert.ok(maxY2 <= maxY1 + 2, `재적용 시 겹침이 과도하게 증가함: ${maxY1} → ${maxY2}`)
})

test('자동 맞춤(사선 접합부): 겹친 끝 모양과 윤곽 변이 만나는 앵커의 접선이 어긋나 변곡점처럼 보이지 않는다', () => {
  const diagFont = ['M 200 900 L 300 900 L 300 600 L 650 250 L 570 170 L 300 440 L 300 100 L 200 100 Z']
  const vBar = strokeOf(rectPath(200, 100, 300, 900), [[250, 880], [250, 120]], { stroke_order: 1 })
  const diag = strokeOf('M 300 600 L 650 250 L 570 170 L 300 440 Z', [[320, 500], [600, 220]], { stroke_order: 2 })
  const result = autoFitLayer([vBar, diag], diagFont)
  assert.equal(mildJoinCount(result.strokes[1].outline_path), 0, result.strokes[1].outline_path)
})
