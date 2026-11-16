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
