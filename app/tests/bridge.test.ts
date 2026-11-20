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
