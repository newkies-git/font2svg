import assert from 'node:assert/strict'
import test from 'node:test'
import { autoFitLayer, autoFitStroke } from '../src/lib/autoFit.ts'
import { transformStroke } from '../src/lib/vectorEdit.ts'
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
