import assert from 'node:assert/strict'
import test from 'node:test'
import { registerMedians } from '../server/registration.ts'
import { ribbonPath } from '../server/geometry.ts'
import type { Pt } from '../shared/types.ts'
import { rectPath } from './helpers.ts'

// 가로 막대 하나: x 100~900, y 460~540(폭 80). 중심선은 y=500.
const BAR = rectPath(100, 460, 900, 540)
// 이미 맞은 입력이 맞춤 보폭 안에서만 움직이는지 보는 허용치
const NEAR = 10
const centerY = (line: Pt[]) => line.reduce((sum, point) => sum + point[1], 0) / line.length

test('등록: 어긋난 참고 중심선이 글자의 획 위치로 옮겨진다', () => {
  const shifted: Pt[][] = [[[160, 560], [840, 560]]]
  const [registered] = registerMedians(shifted, [BAR], ribbonPath)
  assert.ok(Math.abs(centerY(registered) - 500) < Math.abs(centerY(shifted[0]) - 500), `y ${centerY(registered)}`)
  assert.equal(registered.length, shifted[0].length)
})

test('등록: 이미 맞은 중심선은 거의 그대로 두고, 윤곽이 없거나 중심선이 없으면 입력을 돌려준다', () => {
  const exact: Pt[][] = [[[160, 500], [840, 500]]]
  const [kept] = registerMedians(exact, [BAR], ribbonPath)
  assert.ok(Math.abs(centerY(kept) - 500) < NEAR, `y ${centerY(kept)}`)
  assert.equal(registerMedians(exact, [], ribbonPath), exact)
  const none: Pt[][] = []
  assert.equal(registerMedians(none, [BAR], ribbonPath), none)
})
