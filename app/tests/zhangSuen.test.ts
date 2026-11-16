import assert from 'node:assert/strict'
import test from 'node:test'
import { zhangSuen } from '../src/lib/strokeCut.ts'

// 기준 구현(느리지만 정의 그대로): 모든 픽셀을 훑고 이웃 배열을 만든다. 최적화 구현이 이와 같은 결과를 내는지 비교한다.
function referenceZhangSuen(src: Uint8Array, w: number, h: number): Uint8Array {
  const img = src.slice()
  const offsets = [-w, -w + 1, 1, w + 1, w, w - 1, -1, -w - 1]
  let changed = true
  while (changed) {
    changed = false
    for (let step = 0; step < 2; step++) {
      const drop: number[] = []
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x
          if (!img[i]) continue
          const p = offsets.map((offset) => img[i + offset])
          let bp = 0
          let ap = 0
          for (let k = 0; k < 8; k++) {
            bp += p[k]
            if (!p[k] && p[(k + 1) % 8]) ap++
          }
          if (bp < 2 || bp > 6 || ap !== 1) continue
          if (step === 0) {
            if (p[0] && p[2] && p[4]) continue
            if (p[2] && p[4] && p[6]) continue
          } else {
            if (p[0] && p[2] && p[6]) continue
            if (p[0] && p[4] && p[6]) continue
          }
          drop.push(i)
        }
      }
      if (drop.length) {
        changed = true
        for (const i of drop) img[i] = 0
      }
    }
  }
  return img
}

// 결정적 난수(mulberry32)
function rng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomBlobs(w: number, h: number, seed: number): Uint8Array {
  const random = rng(seed)
  const img = new Uint8Array(w * h)
  for (let n = 0; n < 6; n++) {
    const cx = 4 + random() * (w - 8)
    const cy = 4 + random() * (h - 8)
    const rx = 2 + random() * 9
    const ry = 2 + random() * 9
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) img[y * w + x] = 1
  }
  return img
}

test('세선화: 기준 구현과 모든 칸이 같다(무작위 덩어리 30개)', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const w = 48
    const h = 40
    const src = randomBlobs(w, h, seed)
    assert.deepEqual(zhangSuen(src, w, h), referenceZhangSuen(src, w, h), `seed ${seed}`)
  }
})

test('세선화: 가장자리 한 칸의 잉크는 지우지 않는다', () => {
  const w = 12
  const h = 12
  const src = new Uint8Array(w * h).fill(1)
  const out = zhangSuen(src, w, h)
  for (let x = 0; x < w; x++) assert.equal(out[x], 1)
  assert.deepEqual(out, referenceZhangSuen(src, w, h))
})

test('세선화: 원본을 바꾸지 않고, 빈 이미지는 빈 채로', () => {
  const src = randomBlobs(30, 30, 7)
  const copy = src.slice()
  zhangSuen(src, 30, 30)
  assert.deepEqual(src, copy)
  assert.deepEqual(zhangSuen(new Uint8Array(100), 10, 10), new Uint8Array(100))
})
