import assert from 'node:assert/strict'
import test from 'node:test'
import { mildJoinCount, smoothMildJoins } from '../shared/strokeCut/smoothJoins.ts'
import { parseCommands } from '../shared/paths.ts'

// 위쪽 변이 오른쪽 아래로 기운 직선이고, 왼쪽 끝 모양(3차 곡선)의 접선은 수직으로 들어오는 접합부.
// 곡선이 (100,100)과 (100,40)에서 직선과 만나는 두 앵커가 약 30° 꺾인다.
const CAP = 'M 100 100 L 300 90 L 300 50 L 100 40 C 40 45 40 95 100 100 Z'

test('끝 모양 접합부에서 접선이 어긋난 앵커를 센다', () => {
  assert.equal(mildJoinCount(CAP), 2)
})

test('접합부 접선을 직선 방향으로 맞추고 직선의 좌표는 그대로 둔다', () => {
  const smoothed = smoothMildJoins(CAP)
  assert.equal(mildJoinCount(smoothed), 0)
  assert.ok(smoothed.endsWith('Z'), '닫힌 경로를 유지한다')
  const points = parseCommands(smoothed).filter((c) => c.op === 'L').map((c) => c.n.join(','))
  assert.deepEqual(points, ['300,90', '300,50', '100,40'])
  const tips = parseCommands(smoothed).filter((c) => c.op === 'C').flatMap((c) => c.n.slice(4))
  assert.deepEqual(tips, [100, 100], '곡선 끝점(앵커)은 움직이지 않는다')
})

test('고칠 곳이 없으면 같은 문자열을 돌려준다(진짜 모서리·직선끼리의 꺾임은 건드리지 않는다)', () => {
  const square = 'M 0 0 L 100 0 L 100 100 L 0 100 Z'
  assert.equal(smoothMildJoins(square), square)
  const rightCorner = 'M 0 0 L 100 0 C 140 0 140 60 100 60 L 0 60 Z'
  assert.ok(mildJoinCount(rightCorner) === 0)
  assert.equal(smoothMildJoins(rightCorner), rightCorner)
})

test('2차 곡선도 접선을 맞추고, 여러 서브패스를 각각 처리한다', () => {
  const quad = 'M 100 100 L 300 90 L 300 50 L 100 40 Q 40 70 100 100 Z M 500 500 L 600 500 L 600 600 Z'
  assert.ok(mildJoinCount(quad) >= 1)
  const smoothed = smoothMildJoins(quad)
  assert.equal(mildJoinCount(smoothed), 0)
  assert.equal(smoothed.match(/M /g)?.length, 2)
})
