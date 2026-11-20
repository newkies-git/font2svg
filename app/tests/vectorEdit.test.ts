import assert from 'node:assert/strict'
import test from 'node:test'
import { strokeWidthCap } from '../shared/clamp.ts'
import { MIN_STROKE_WIDTH } from '../shared/constants.ts'
import {
  insertMedianPoint,
  mergeTwoStrokes,
  moveEditableHandle,
  parseEditablePath,
  pathsBBox,
  recomputeStrokeWidth,
  removeMedianPoint,
  reverseMedian,
  serializeEditablePath,
  strokesBBox,
  transformPath,
  transformStroke,
} from '../src/lib/vectorEdit.ts'
import { rectPath, strokeOf } from './helpers.ts'

test('경로를 편집 가능한 선분으로 읽고 다시 쓴다(왕복)', () => {
  const d = 'M 0 0 L 10 0 Q 15 5 10 10 C 8 12 2 12 0 10 Z'
  const segs = parseEditablePath(d)
  assert.deepEqual(segs.map((seg) => seg.op), ['M', 'L', 'Q', 'C', 'Z'])
  assert.equal(serializeEditablePath(segs), d)
})

test('좌표는 소수 첫째 자리까지만 쓰고 정수는 소수점 없이 쓴다', () => {
  assert.equal(serializeEditablePath(parseEditablePath('M 1.04 2.26 L 3 4 Z')), 'M 1 2.3 L 3 4 Z')
})

test('제어점 이동: 해당 제어점만 바뀌고 원본 배열은 그대로다', () => {
  const segs = parseEditablePath('M 0 0 C 1 1 2 2 3 3 Q 4 4 5 5 Z')
  const moved = moveEditableHandle(segs, { kind: 'c1', segIndex: 1 }, [9.04, 8.06])
  assert.deepEqual(moved[1], { op: 'C', x1: 9, y1: 8.1, x2: 2, y2: 2, x: 3, y: 3 })
  assert.deepEqual(segs[1], { op: 'C', x1: 1, y1: 1, x2: 2, y2: 2, x: 3, y: 3 }, '원본 불변')
  const second = moveEditableHandle(segs, { kind: 'c2', segIndex: 1 }, [7, 7])
  assert.deepEqual(second[1], { op: 'C', x1: 1, y1: 1, x2: 7, y2: 7, x: 3, y: 3 })
  const quad = moveEditableHandle(segs, { kind: 'c1', segIndex: 2 }, [6, 6])
  assert.deepEqual(quad[2], { op: 'Q', x1: 6, y1: 6, x: 5, y: 5 })
})

test('c2는 C에만, c1은 Q·C에만 적용되고 Z나 없는 선분은 그대로 둔다', () => {
  const segs = parseEditablePath('M 0 0 L 1 1 Q 2 2 3 3 Z')
  assert.deepEqual(moveEditableHandle(segs, { kind: 'c2', segIndex: 2 }, [9, 9]), segs, 'Q에는 c2가 없다')
  assert.deepEqual(moveEditableHandle(segs, { kind: 'c1', segIndex: 1 }, [9, 9]), segs, 'L에는 제어점이 없다')
  assert.deepEqual(moveEditableHandle(segs, { kind: 'anchor', segIndex: 3 }, [9, 9]), segs, 'Z는 옮기지 않는다')
  assert.deepEqual(moveEditableHandle(segs, { kind: 'anchor', segIndex: 99 }, [9, 9]), segs)
})

test('앵커 이동: 붙은 제어점(들어오는/나가는)이 같은 양만큼 따라간다', () => {
  const segs = parseEditablePath('M 0 0 C 10 0 20 0 30 0 C 40 0 50 0 60 0')
  const moved = moveEditableHandle(segs, { kind: 'anchor', segIndex: 1 }, [35, 5])
  assert.deepEqual(moved[1], { op: 'C', x1: 10, y1: 0, x2: 25, y2: 5, x: 35, y: 5 }, '들어오는 제어점(c2)')
  assert.deepEqual(moved[2], { op: 'C', x1: 45, y1: 5, x2: 50, y2: 0, x: 60, y: 0 }, '나가는 제어점(다음 선분의 c1)')
  const quadSegs = parseEditablePath('M 0 0 L 10 0 Q 12 4 20 0')
  const afterL = moveEditableHandle(quadSegs, { kind: 'anchor', segIndex: 1 }, [10, 10])
  assert.deepEqual(afterL[2], { op: 'Q', x1: 12, y1: 14, x: 20, y: 0 })
})

test('시작점(M)을 옮기면 같은 자리에서 닫히는 끝점도 함께 옮겨 틈이 생기지 않는다', () => {
  const segs = parseEditablePath('M 0 0 L 10 0 L 10 10 L 0 0 Z')
  const moved = moveEditableHandle(segs, { kind: 'anchor', segIndex: 0 }, [2, 2])
  assert.deepEqual(moved[0], { op: 'M', x: 2, y: 2 })
  assert.deepEqual(moved[3], { op: 'L', x: 2, y: 2 })
  // 곡선으로 닫히면 끝점의 c2도 같이 이동
  const curved = parseEditablePath('M 0 0 L 10 0 C 10 5 5 5 0 0 Z')
  const movedCurve = moveEditableHandle(curved, { kind: 'anchor', segIndex: 0 }, [3, 3])
  assert.deepEqual(movedCurve[2], { op: 'C', x1: 10, y1: 5, x2: 8, y2: 8, x: 3, y: 3 })
  // 끝점이 시작점과 떨어져 있으면 닫힘 보정을 하지 않는다
  const open = parseEditablePath('M 0 0 L 10 0 L 10 10 Z')
  assert.deepEqual(moveEditableHandle(open, { kind: 'anchor', segIndex: 0 }, [2, 2])[2], { op: 'L', x: 10, y: 10 })
})

test('여러 서브패스: 한 서브패스의 시작점 이동이 다음 서브패스에 번지지 않는다', () => {
  const segs = parseEditablePath('M 0 0 L 5 0 M 0 0 L 9 9 L 0 0 Z')
  const moved = moveEditableHandle(segs, { kind: 'anchor', segIndex: 0 }, [1, 1])
  assert.deepEqual(moved[4], { op: 'L', x: 0, y: 0 })
})

test('경로 변환: 직선·2차·3차 곡선의 모든 점을 변환한다', () => {
  const shift = (x: number, y: number): [number, number] => [x + 10, y - 5]
  assert.equal(transformPath('M 0 0 L 1 1 Q 2 2 3 3 C 4 4 5 5 6 6 Z', shift), 'M 10 -5 L 11 -4 Q 12 -3 13 -2 C 14 -1 15 0 16 1 Z')
})

test('획 변환: 윤곽·중심선을 옮기고 폭은 배율로 키우되 한도 안으로 맞춘다', () => {
  const stroke = strokeOf(rectPath(0, 0, 10, 10), [[1, 1], [9, 9]], { stroke_width: 100 })
  const doubled = transformStroke(stroke, (x, y) => [x * 2, y * 2], 2)
  assert.deepEqual(doubled.median_points, [[2, 2], [18, 18]])
  assert.equal(doubled.stroke_width, 200)
  const cap = strokeWidthCap()
  assert.equal(transformStroke(stroke, (x, y) => [x, y], 1000).stroke_width, cap)
  assert.equal(transformStroke(stroke, (x, y) => [x, y], 0.0001).stroke_width, MIN_STROKE_WIDTH)
  assert.equal(stroke.stroke_width, 100, '원본 불변')
})

test('경계 상자: 윤곽 합집합, 윤곽이 없으면 중심선, 둘 다 없으면 null', () => {
  assert.deepEqual(pathsBBox([rectPath(0, 0, 10, 10), rectPath(5, -5, 20, 8)]), { minX: 0, minY: -5, maxX: 20, maxY: 10 })
  assert.equal(pathsBBox([]), null)
  assert.equal(pathsBBox(['']), null)
  assert.deepEqual(strokesBBox([strokeOf(rectPath(0, 0, 10, 10), [[1, 1]])]), { minX: 0, minY: 0, maxX: 10, maxY: 10 })
  const noOutline = [strokeOf('', [[3, 4], [1, 9]]), strokeOf('', [[7, 2]])]
  assert.deepEqual(strokesBBox(noOutline), { minX: 1, minY: 2, maxX: 7, maxY: 9 })
  assert.equal(strokesBBox([strokeOf('', [])]), null)
})

test('중심선 정점 삽입: 가장 가까운 선분 사이에 끼우고 번호를 돌려준다', () => {
  const points: [number, number][] = [[0, 0], [10, 0], [10, 10]]
  const result = insertMedianPoint(points, [10.04, 5.06])
  assert.deepEqual(result.points, [[0, 0], [10, 0], [10, 5.1], [10, 10]])
  assert.equal(result.insertedIndex, 2)
  assert.equal(points.length, 3, '원본 불변')
  assert.deepEqual(insertMedianPoint([[0, 0]], [3, 3]), { points: [[0, 0], [3, 3]], insertedIndex: 1 })
  assert.deepEqual(insertMedianPoint([[0, 0], [0, 0]], [4, 4]).points.length, 3, '길이 0 선분도 안전하다')
})

test('중심선 정점 삭제는 최소 개수 아래로 내려가지 않고, 반전은 새 배열을 준다', () => {
  assert.deepEqual(removeMedianPoint([[0, 0], [1, 1], [2, 2]], 1), [[0, 0], [2, 2]])
  const two: [number, number][] = [[0, 0], [1, 1]]
  assert.equal(removeMedianPoint(two, 0), two)
  const reversed = reverseMedian(two)
  assert.deepEqual(reversed, [[1, 1], [0, 0]])
  assert.notEqual(reversed[0], two[1], '점도 복제한다')
})

test('획 폭 재계산: 입력이 모자라면 기존 값을 유지하고, 충분하면 새로 계산한다', () => {
  assert.equal(recomputeStrokeWidth('', [[0, 0], [1, 1]], 77), 77)
  assert.equal(recomputeStrokeWidth(rectPath(0, 0, 10, 10), [[1, 1]], 77), 77)
  const width = recomputeStrokeWidth(rectPath(100, 100, 500, 160), [[110, 130], [490, 130]], 77)
  assert.ok(width >= MIN_STROKE_WIDTH && width !== 77)
})

test('획 병합: 윤곽을 합치고 중심선 방향은 첫 획 기필 쪽으로 맞추며 속성을 합친다', () => {
  const first = strokeOf(rectPath(100, 100, 300, 160), [[110, 130], [290, 130]], { stroke_order: 3, is_radical: 0, start_cap_type: 'AUTO_ROUND', stroke_width: 60 })
  const second = strokeOf(rectPath(300, 100, 500, 160), [[310, 130], [490, 130]], { is_radical: 1, end_cap_type: 'REF_STAMP', stroke_width: 90 })
  const merged = mergeTwoStrokes(first, second)
  assert.equal(merged.stroke_order, 3)
  assert.equal(merged.outline_path, `${first.outline_path} ${second.outline_path}`)
  assert.equal(merged.is_radical, 1)
  assert.equal(merged.start_cap_type, 'AUTO_ROUND')
  assert.equal(merged.end_cap_type, 'REF_STAMP')
  assert.ok(merged.stroke_width >= MIN_STROKE_WIDTH)
  assert.ok(merged.median_points[0][0] < merged.median_points[merged.median_points.length - 1][0], '첫 획 기필(왼쪽)에서 시작')
  // 첫 획의 기필이 오른쪽 끝 근처면, 합친 중심선도 오른쪽에서 시작하도록 뒤집는다.
  const rightFirst = strokeOf(rectPath(300, 100, 500, 160), [[490, 130], [310, 130]])
  const leftSecond = strokeOf(rectPath(100, 100, 300, 160), [[290, 130], [110, 130]])
  const flipped = mergeTwoStrokes(rightFirst, leftSecond)
  assert.ok(flipped.median_points[0][0] > flipped.median_points[flipped.median_points.length - 1][0])
})

test('획 병합: 윤곽에서 중심선을 못 구하면 두 중심선을 이어 붙인다', () => {
  const first = strokeOf('', [[0, 0], [1, 1]])
  const second = strokeOf('', [[2, 2], [3, 3]])
  const merged = mergeTwoStrokes(first, second)
  assert.deepEqual(merged.median_points, [[0, 0], [1, 1], [2, 2], [3, 3]])
  assert.equal(merged.stroke_width, 100, '폭도 못 구하면 두 획 중 큰 값')
})
