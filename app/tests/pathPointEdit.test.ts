import assert from 'node:assert/strict'
import test from 'node:test'
import {
  anchorIndicesInBox,
  canDeleteAnchors,
  deleteEditableAnchors,
  expandSeamPartners,
  insertPathPointAt,
  insertPathPointOnSelection,
  moveEditableAnchors,
  simplifyEditablePath,
  togglePathSegmentCurve,
} from '../src/lib/pathPointEdit.ts'
import { parseEditablePath } from '../shared/vectorEdit.ts'

test('expandSeamPartners: 닫힌 서브패스의 시작점(M)과 마지막 겹침 끝점은 함께 묶인다', () => {
  const closed = parseEditablePath('M 0 0 L 100 0 L 100 50 L 0 0 Z')
  assert.deepEqual([...expandSeamPartners(closed, [0])].sort((a, b) => a - b), [0, 3])
  assert.deepEqual([...expandSeamPartners(closed, [3])].sort((a, b) => a - b), [0, 3])

  const open = parseEditablePath('M 0 0 L 100 0 L 0 0')
  assert.deepEqual([...expandSeamPartners(open, [0])], [0])

  const multi = parseEditablePath('M 0 0 L 10 0 L 0 0 Z M 20 20 L 30 20 L 20 20 Z')
  assert.deepEqual([...expandSeamPartners(multi, [4])].sort((a, b) => a - b), [4, 6])
})

test('anchorIndicesInBox: 사각형 영역 안의 정점만 고르고 닫힘 이음새도 함께 포함한다', () => {
  const segs = parseEditablePath('M 10 10 L 90 10 L 90 90 L 10 90 L 10 10 Z')
  assert.deepEqual(anchorIndicesInBox(segs, { minX: 80, minY: 0, maxX: 100, maxY: 100 }), [1, 2])
  assert.deepEqual(anchorIndicesInBox(segs, { minX: 0, minY: 0, maxX: 20, maxY: 20 }), [0, 4])
})

test('moveEditableAnchors: 여러 정점을 한 번에 옮겨도 이음새와 제어점이 두 번 이동하지 않는다', () => {
  const segs = parseEditablePath('M 0 0 C 0 10 40 10 50 0 L 50 50 C 40 40 0 10 0 0 Z')
  // M(0), seam(3), 그리고 인접 곡선 앵커 1을 함께 이동
  const moved = moveEditableAnchors(segs, [0, 1], 10, -5)
  assert.deepEqual(moved[0], { op: 'M', x: 10, y: -5 })
  assert.deepEqual(moved[1], { op: 'C', x1: 10, y1: 5, x2: 50, y2: 5, x: 60, y: -5 })
  assert.deepEqual(moved[2], { op: 'L', x: 50, y: 50 })
  assert.deepEqual(moved[3], { op: 'C', x1: 40, y1: 40, x2: 10, y2: 5, x: 10, y: -5 })
  assert.deepEqual(moveEditableAnchors(segs, [99], 10, 10), segs)
})

test('insertPathPointAt: 직선·2차·3차 곡선과 암묵 닫힘 변을 정확히 분할한다', () => {
  // 직선 분할
  const rect = parseEditablePath('M 0 0 L 100 0 L 100 100 L 0 100 Z')
  const lineSplit = insertPathPointAt(rect, [30, 2])!
  assert.equal(lineSplit.insertedIndex, 1)
  assert.deepEqual(lineSplit.segs[1], { op: 'L', x: 30, y: 0 })
  assert.deepEqual(lineSplit.segs[2], { op: 'L', x: 100, y: 0 })

  // 암묵 닫힘 변(Z 앞 0,100 -> 0,0) 분할
  const closingSplit = insertPathPointAt(rect, [1, 40])!
  assert.equal(closingSplit.insertedIndex, 4)
  assert.deepEqual(closingSplit.segs[4], { op: 'L', x: 0, y: 40 })
  assert.equal(closingSplit.segs[5].op, 'Z')

  // 2차 곡선(Q) 분할
  const quad = parseEditablePath('M 0 0 Q 50 100 100 0 Z')
  const quadSplit = insertPathPointAt(quad, [50, 50])!
  assert.equal(quadSplit.insertedIndex, 1)
  assert.equal(quadSplit.segs[1].op, 'Q')
  assert.equal(quadSplit.segs[2].op, 'Q')
  if (quadSplit.segs[1].op === 'Q') {
    assert.ok(Math.abs(quadSplit.segs[1].x - 50) <= 0.2)
    assert.ok(Math.abs(quadSplit.segs[1].y - 50) <= 0.2)
  }

  // 3차 곡선(C) 분할: 분할된 두 곡선이 원래 곡선과 같은 점을 지난다
  const cubic = parseEditablePath('M 0 0 C 0 80 100 80 100 0 Z')
  const cubicSplit = insertPathPointAt(cubic, [50, 60])!
  assert.equal(cubicSplit.insertedIndex, 1)
  assert.equal(cubicSplit.segs[1].op, 'C')
  assert.equal(cubicSplit.segs[2].op, 'C')
  if (cubicSplit.segs[1].op === 'C' && cubicSplit.segs[2].op === 'C') {
    assert.ok(Math.abs(cubicSplit.segs[1].x - 50) <= 0.2)
    assert.ok(Math.abs(cubicSplit.segs[1].y - 60) <= 0.2)
    // 왼쪽 절반 u=0.5 == 원 곡선 t=0.25 ((1 - t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3)
    const s1 = cubicSplit.segs[1]
    const lx = 0.125 * 0 + 0.375 * s1.x1 + 0.375 * s1.x2 + 0.125 * s1.x
    const ly = 0.125 * 0 + 0.375 * s1.y1 + 0.375 * s1.y2 + 0.125 * s1.y
    const origT = 0.25
    const omt = 1 - origT
    const ox = 3 * omt * omt * origT * 0 + 3 * omt * origT * origT * 100 + origT * origT * origT * 100
    const oy = 3 * omt * omt * origT * 80 + 3 * omt * origT * origT * 80
    assert.ok(Math.abs(lx - ox) <= 0.5 && Math.abs(ly - oy) <= 0.5)
  }
})

test('insertPathPointOnSelection: 선택 구간 분할과 미선택 시 최장 구간 분할', () => {
  const segs = parseEditablePath('M 0 0 L 20 0 L 20 200 L 0 200 Z')
  const longest = insertPathPointOnSelection(segs, [])!
  assert.deepEqual(longest.insertedIndices, [2])
  assert.deepEqual(longest.segs[2], { op: 'L', x: 20, y: 100 })

  const multi = insertPathPointOnSelection(segs, [1, 3])!
  assert.deepEqual(multi.insertedIndices, [1, 4])
  assert.deepEqual(multi.segs[1], { op: 'L', x: 10, y: 0 })
  assert.deepEqual(multi.segs[4], { op: 'L', x: 10, y: 200 })
})

test('togglePathSegmentCurve: 직선은 3차 곡선(1/3·2/3)으로, 곡선은 직선으로 바꾼다', () => {
  const rect = parseEditablePath('M 0 0 L 90 0 L 90 90 L 0 90 Z')
  const toCurve = togglePathSegmentCurve(rect, [1])!
  assert.deepEqual(toCurve[1], { op: 'C', x1: 30, y1: 0, x2: 60, y2: 0, x: 90, y: 0 })

  // 직선과 곡선이 섞여 있으면 직선만 곡선으로 통일
  const mixed = togglePathSegmentCurve(toCurve, [1, 2])!
  assert.equal(mixed[1].op, 'C')
  assert.deepEqual(mixed[2], { op: 'C', x1: 90, y1: 30, x2: 90, y2: 60, x: 90, y: 90 })

  // 모두 곡선이면 직선으로 복귀
  const backToLine = togglePathSegmentCurve(mixed, [1, 2])!
  assert.deepEqual(backToLine[1], { op: 'L', x: 90, y: 0 })
  assert.deepEqual(backToLine[2], { op: 'L', x: 90, y: 90 })
})

test('deleteEditableAnchors: 정점 삭제 및 시작점 승격, 닫힌 윤곽 최소 3점 보장', () => {
  const quad = parseEditablePath('M 0 0 L 100 0 L 100 100 L 0 100 Z')
  assert.equal(canDeleteAnchors(quad, [1]), true)
  const trimmed = deleteEditableAnchors(quad, [1])!
  assert.equal(trimmed.length, 4)

  // M(0) 삭제 시 다음 정점이 M으로 승격
  const dropStart = deleteEditableAnchors(quad, [0])!
  assert.deepEqual(dropStart[0], { op: 'M', x: 100, y: 0 })
  assert.equal(dropStart[dropStart.length - 1].op, 'Z')

  // 이미 삼각형이면 더 이상 삭제 불가
  assert.equal(canDeleteAnchors(trimmed, [2]), false)
  assert.equal(deleteEditableAnchors(trimmed, [2]), null)

  // 시작/끝 이음새가 있는 사각형(세그 4개+Z, 고유 정점 3개)에서 M(0)을 삭제하면 <3 이므로 거부
  const seamTri = parseEditablePath('M 0 0 L 100 0 L 100 100 L 0 0 Z')
  assert.equal(canDeleteAnchors(seamTri, [0]), false)
  assert.equal(deleteEditableAnchors(seamTri, [0]), null)
})

test('simplifyEditablePath: 일직선 계단 정점을 줄이고 곡선과 비선택 영역은 유지한다', () => {
  // 촘촘한 일직선 L 계단 + 3차 곡선 C가 섞인 윤곽
  const staircase = parseEditablePath(
    'M 0 0 L 20 0 L 40 0.5 L 60 0 L 80 0 L 100 0 C 120 40 120 60 100 100 L 0 100 Z',
  )
  const simplified = simplifyEditablePath(staircase, [], 2.5)!
  // M(0,0) -> L(100,0) -> C(120,40, 120,60, 100,100) -> L(0,100) -> Z
  assert.equal(simplified.length, 5)
  assert.deepEqual(simplified[0], { op: 'M', x: 0, y: 0 })
  assert.deepEqual(simplified[1], { op: 'L', x: 100, y: 0 })
  assert.equal(simplified[2].op, 'C')
  assert.deepEqual(simplified[3], { op: 'L', x: 0, y: 100 })
  assert.equal(simplified[4].op, 'Z')

  // 선택 영역이 3점 이상이면 선택 영역 안의 직선 구간만 단순화한다
  const twoRuns = parseEditablePath(
    'M 0 0 L 30 0 L 60 0 L 90 0 L 90 100 L 60 100 L 30 100 L 0 100 Z',
  )
  const partial = simplifyEditablePath(twoRuns, [0, 1, 2, 3], 2.5)!
  // 위쪽(0..3)의 1, 2만 제거되고 아래쪽(4..7)은 그대로 유지
  assert.equal(partial.length, 7)
  assert.deepEqual(partial[1], { op: 'L', x: 90, y: 0 })
  assert.deepEqual(partial[3], { op: 'L', x: 60, y: 100 })

  // 이미 삼각형이면 null (최소 3점 유지)
  const tri = parseEditablePath('M 0 0 L 100 0 L 100 100 Z')
  assert.equal(simplifyEditablePath(tri, [], 2.5), null)
})
