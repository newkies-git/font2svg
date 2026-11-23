import assert from 'node:assert/strict'
import test from 'node:test'
import { flattenContours, polygonArea, type Pt } from '../shared/paths.ts'
import { fitClosedLoop, fitOpenPolyline } from '../shared/strokeCut/curveFit.ts'

const circle = (radius: number, count: number): Pt[] =>
  Array.from({ length: count }, (_, i) => ({ x: 500 + radius * Math.cos((2 * Math.PI * i) / count), y: 500 + radius * Math.sin((2 * Math.PI * i) / count) }))

// 변 위를 일정 간격으로 촘촘히 채운 닫힌 사각형(모서리 4개)
function denseRect(x0: number, y0: number, x1: number, y1: number, step: number): Pt[] {
  const corners: Pt[] = [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]
  const out: Pt[] = []
  corners.forEach((a, index) => {
    const b = corners[(index + 1) % corners.length]
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step)
    for (let k = 0; k < steps; k++) out.push({ x: a.x + ((b.x - a.x) * k) / steps, y: a.y + ((b.y - a.y) * k) / steps })
  })
  return out
}

test('촘촘한 원은 적은 곡선으로 맞고, 면적이 거의 같다', () => {
  const path = fitClosedLoop(circle(100, 400))
  assert.ok(path)
  assert.ok((path.match(/C/g) ?? []).length <= 8, path)
  assert.ok(!path.includes('L'))
  const area = Math.abs(polygonArea(flattenContours(path, 0.2)[0]))
  assert.ok(Math.abs(area - Math.PI * 100 * 100) < Math.PI * 100 * 100 * 0.01, `면적 ${area}`)
})

test('사각형은 모서리 4개를 살린 직선 4개로 줄어든다', () => {
  const path = fitClosedLoop(denseRect(100, 100, 400, 300, 2))
  assert.ok(path)
  assert.equal((path.match(/L/g) ?? []).length, 4, path)
  assert.ok(!path.includes('C'))
  const area = Math.abs(polygonArea(flattenContours(path, 0.2)[0]))
  assert.ok(Math.abs(area - 300 * 200) < 300 * 200 * 0.01)
})

test('열린 점열: 직선은 L 하나, 꺾인 선은 모서리에서 나눈다', () => {
  const straight = Array.from({ length: 50 }, (_, i): Pt => ({ x: i * 4, y: 0 }))
  assert.equal(fitOpenPolyline(straight), 'L196 0')
  const bent = [...straight, ...Array.from({ length: 50 }, (_, i): Pt => ({ x: 196, y: (i + 1) * 4 }))]
  const commands = fitOpenPolyline(bent)
  assert.equal((commands.match(/L/g) ?? []).length, 2, commands)
})

test('점이 모자라면 닫힌 윤곽은 null, 열린 점열은 직선으로 잇는다', () => {
  assert.equal(fitClosedLoop([{ x: 0, y: 0 }, { x: 1, y: 1 }]), null)
  assert.equal(fitOpenPolyline([{ x: 0, y: 0 }, { x: 5, y: 5 }]), 'L5 5')
})
