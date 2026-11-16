import assert from 'node:assert/strict'
import test from 'node:test'
import { flattenContours } from '../shared/paths.ts'
import { extractStrokeAlongGuide } from '../shared/strokeCut.ts'
import { extractStrokeAtGuide } from '../src/lib/strokeOps.ts'
import { strokeOf } from './helpers.ts'

// 十: 가로 y 460~540(x 200~800), 세로 x 460~540(y 200~800). 교차부는 가운데 80×80 정사각형
const CROSS = 'M460 800 L540 800 L540 540 L800 540 L800 460 L540 460 L540 200 L460 200 L460 460 L200 460 L200 540 L460 540 Z'
const CENTER = { x: 500, y: 500 }
const HORIZONTAL_GUIDE = [{ x: 200, y: 500 }, { x: 800, y: 500 }]
const VERTICAL_GUIDE = [{ x: 500, y: 800 }, { x: 500, y: 200 }]
// 래스터화 오차를 감안한 허용 거리
const TOLERANCE = 6

// 윤곽(구멍 포함, 비영 감기수 규칙)이 점을 덮는지
function covers(path: string, point: { x: number; y: number }): boolean {
  let winding = 0
  for (const contour of flattenContours(path, 1.4)) {
    for (let i = 0; i < contour.length; i++) {
      const a = contour[i]
      const b = contour[(i + 1) % contour.length]
      if ((a.y <= point.y) !== (b.y <= point.y)) {
        const t = (point.y - a.y) / (b.y - a.y)
        if (a.x + t * (b.x - a.x) > point.x) winding += b.y > a.y ? 1 : -1
      }
    }
  }
  return winding !== 0
}

function boundsOf(path: string) {
  const points = flattenContours(path, 1.4).flat()
  const xs = points.map((point) => point.x)
  const ys = points.map((point) => point.y)
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) }
}

test('十를 가로 안내선으로 나누면 ―와 ㅣ가 되고, 교차부는 두 획이 모두 가진다', () => {
  const result = extractStrokeAlongGuide(CROSS, HORIZONTAL_GUIDE)
  assert.ok(result)
  assert.equal(result.stroke.length, 1, '―')
  assert.equal(result.rest.length, 1, 'ㅣ는 교차부로 이어져 한 조각이다(위·아래로 갈라지지 않는다)')
  const [bar] = result.stroke
  const [stem] = result.rest
  const barBounds = boundsOf(bar)
  assert.ok(barBounds.minX <= 200 + TOLERANCE && barBounds.maxX >= 800 - TOLERANCE, '―가 가로 전체를 가진다')
  assert.ok(barBounds.maxY - barBounds.minY <= 80 + TOLERANCE * 2, '―는 세로로 번지지 않는다')
  const stemBounds = boundsOf(stem)
  assert.ok(stemBounds.minY <= 200 + TOLERANCE && stemBounds.maxY >= 800 - TOLERANCE, 'ㅣ가 세로 전체를 가진다')
  assert.ok(stemBounds.maxX - stemBounds.minX <= 80 + TOLERANCE * 2, 'ㅣ는 가로로 번지지 않는다')
  assert.equal(covers(bar, CENTER), true, '―가 교차부를 가진다')
  assert.equal(covers(stem, CENTER), true, 'ㅣ도 교차부를 가진다')
})

test('세로 안내선으로 나눠도 같은 결과(―와 ㅣ, 교차부 공유)다', () => {
  const result = extractStrokeAlongGuide(CROSS, VERTICAL_GUIDE)
  assert.ok(result)
  assert.equal(result.stroke.length, 1)
  assert.equal(result.rest.length, 1)
  const stemBounds = boundsOf(result.stroke[0])
  assert.ok(stemBounds.minY <= 200 + TOLERANCE && stemBounds.maxY >= 800 - TOLERANCE)
  assert.equal(covers(result.stroke[0], CENTER) && covers(result.rest[0], CENTER), true)
})

test('교차하지 않은 곳은 한쪽에만 속한다(가로 팔 끝은 ―에만, 세로 끝은 ㅣ에만)', () => {
  const result = extractStrokeAlongGuide(CROSS, HORIZONTAL_GUIDE)
  assert.ok(result)
  const armTip = { x: 250, y: 500 }
  const stemTip = { x: 500, y: 250 }
  assert.equal(covers(result.stroke[0], armTip), true)
  assert.equal(covers(result.rest[0], armTip), false)
  assert.equal(covers(result.rest[0], stemTip), true)
  assert.equal(covers(result.stroke[0], stemTip), false)
})

test('면적이 거의 없는 윤곽은 예외 없이 null이다', () => {
  assert.equal(extractStrokeAlongGuide('M 0 0 L 100 0 L 50 0 Z', [{ x: 0, y: 0 }, { x: 100, y: 0 }]), null)
})

test('꺾인 안내선도 쓸 수 있고, 윤곽과 만나지 않거나 점이 모자라면 null', () => {
  assert.ok(extractStrokeAlongGuide(CROSS, [{ x: 200, y: 500 }, { x: 500, y: 500 }, { x: 800, y: 500 }]))
  assert.equal(extractStrokeAlongGuide(CROSS, [{ x: 0, y: 900 }, { x: 1000, y: 900 }]), null)
  assert.equal(extractStrokeAlongGuide(CROSS, [{ x: 500, y: 500 }]), null)
})

test('획 단위: 十 한 획이 ―와 ㅣ 두 획이 되고, 안내선에 닿은 획이 먼저 온다', () => {
  const cross = strokeOf(CROSS, [[0, 0], [1, 1]], { stroke_width: 80 })
  const pieces = extractStrokeAtGuide(cross, HORIZONTAL_GUIDE)
  assert.ok(pieces)
  assert.equal(pieces.length, 2)
  const [first, second] = pieces.map((piece) => boundsOf(piece.outline_path))
  assert.ok(first.maxX - first.minX > first.maxY - first.minY, '먼저 오는 획이 가로 획(―)')
  assert.ok(second.maxY - second.minY > second.maxX - second.minX, '다음이 세로 획(ㅣ)')
  assert.equal(extractStrokeAtGuide(cross, [{ x: 0, y: 900 }, { x: 1000, y: 900 }]), null)
})
