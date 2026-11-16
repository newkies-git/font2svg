import type { Pt } from '../../shared/types.ts'
import type { BBox } from './vectorEdit.ts'

// 포토샵 자유 변형과 같은 4가지 방식. 모두 (x, y) → (x', y')로 점을 옮기는 함수를 돌려준다.
export type TransformMode = 'scale' | 'rotate' | 'skew' | 'distort'
export type HandleDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'
export type PointMap = (x: number, y: number) => Pt

// 회전 각도를 이 값(도)의 배수로 맞춘다(Shift).
const ROTATE_SNAP_DEG = 15
// 기울임·왜곡에서 박스 변이 이 길이보다 짧으면 0으로 나누지 않도록 최소값으로 본다.
const MIN_BOX_SIDE = 4

const RAD_PER_DEG = Math.PI / 180

const CORNER_DIRS: readonly HandleDir[] = ['nw', 'ne', 'se', 'sw']
const EDGE_DIRS: readonly HandleDir[] = ['n', 'e', 's', 'w']

// 방식별로 보여 줄 핸들. 크기는 8방향, 회전·왜곡은 모서리, 기울임은 변의 중앙.
export function handleDirsFor(mode: TransformMode): readonly HandleDir[] {
  if (mode === 'rotate' || mode === 'distort') return CORNER_DIRS
  if (mode === 'skew') return EDGE_DIRS
  return [...CORNER_DIRS, ...EDGE_DIRS]
}

// y축이 위쪽이므로 maxY가 화면 위쪽(north)이다.
export function handlePoint(box: BBox, dir: HandleDir): Pt {
  const mx = (box.minX + box.maxX) / 2
  const my = (box.minY + box.maxY) / 2
  const x = dir.includes('w') ? box.minX : dir.includes('e') ? box.maxX : mx
  const y = dir.includes('s') ? box.minY : dir.includes('n') ? box.maxY : my
  return [x, y]
}

export function rotateMap(center: Pt, start: Pt, current: Pt, snap: boolean): PointMap {
  let angle = Math.atan2(current[1] - center[1], current[0] - center[0]) - Math.atan2(start[1] - center[1], start[0] - center[0])
  if (snap) {
    const step = ROTATE_SNAP_DEG * RAD_PER_DEG
    angle = Math.round(angle / step) * step
  }
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return (x, y) => {
    const dx = x - center[0]
    const dy = y - center[1]
    return [center[0] + dx * cos - dy * sin, center[1] + dx * sin + dy * cos]
  }
}

// 변의 중앙 핸들을 끌면 반대편 변을 고정하고 그 변을 따라 밀어 기울인다.
export function skewMap(box: BBox, dir: HandleDir, start: Pt, current: Pt): PointMap {
  const [hx, hy] = handlePoint(box, dir)
  if (dir === 'n' || dir === 's') {
    const anchorY = dir === 'n' ? box.minY : box.maxY
    const span = Math.abs(hy - anchorY) < MIN_BOX_SIDE ? MIN_BOX_SIDE : hy - anchorY
    const shift = current[0] - start[0]
    return (x, y) => [x + (shift * (y - anchorY)) / span, y]
  }
  const anchorX = dir === 'e' ? box.minX : box.maxX
  const span = Math.abs(hx - anchorX) < MIN_BOX_SIDE ? MIN_BOX_SIDE : hx - anchorX
  const shift = current[1] - start[1]
  return (x, y) => [x, y + (shift * (x - anchorX)) / span]
}

// 모서리 하나만 옮기고 나머지 세 모서리는 고정한다. 박스 안의 점은 네 모서리의 쌍선형 보간으로 옮긴다.
export function distortMap(box: BBox, dir: HandleDir, start: Pt, current: Pt): { map: PointMap; areaRatio: number } {
  const w = Math.max(MIN_BOX_SIDE, box.maxX - box.minX)
  const h = Math.max(MIN_BOX_SIDE, box.maxY - box.minY)
  const corners: Record<'sw' | 'se' | 'nw' | 'ne', Pt> = {
    sw: [box.minX, box.minY],
    se: [box.maxX, box.minY],
    nw: [box.minX, box.maxY],
    ne: [box.maxX, box.maxY],
  }
  const moved = { ...corners }
  if (dir === 'sw' || dir === 'se' || dir === 'nw' || dir === 'ne') {
    moved[dir] = [corners[dir][0] + current[0] - start[0], corners[dir][1] + current[1] - start[1]]
  }
  const map: PointMap = (x, y) => {
    const u = (x - box.minX) / w
    const v = (y - box.minY) / h
    const weights: [number, 'sw' | 'se' | 'nw' | 'ne'][] = [
      [(1 - u) * (1 - v), 'sw'],
      [u * (1 - v), 'se'],
      [(1 - u) * v, 'nw'],
      [u * v, 'ne'],
    ]
    return [
      weights.reduce((sum, [wt, key]) => sum + wt * moved[key][0], 0),
      weights.reduce((sum, [wt, key]) => sum + wt * moved[key][1], 0),
    ]
  }
  // 사각형(sw→se→ne→nw) 넓이 비율 — 획 폭 보정에 쓴다.
  const ring = [moved.sw, moved.se, moved.ne, moved.nw]
  const twice = ring.reduce((sum, [x, y], i) => {
    const [nx, ny] = ring[(i + 1) % ring.length]
    return sum + (x * ny - nx * y)
  }, 0)
  return { map, areaRatio: Math.abs(twice / 2) / (w * h) }
}

// 크기 조절 시 뒤집힘을 막는 최소 배율
const MIN_SCALE = 0.1

// 크기 조절: 끈 핸들의 반대편을 고정하고 박스를 늘이거나 줄인다. Shift는 가로·세로 같은 비율.
function scaleMap(box: BBox, dir: HandleDir, current: Pt, uniform: boolean): { fn: PointMap; scaleFactor: number } {
  const w0 = Math.max(MIN_BOX_SIDE, box.maxX - box.minX)
  const h0 = Math.max(MIN_BOX_SIDE, box.maxY - box.minY)
  const anchorX = dir.includes('w') ? box.maxX : dir.includes('e') ? box.minX : (box.minX + box.maxX) / 2
  const anchorY = dir.includes('s') ? box.maxY : dir.includes('n') ? box.minY : (box.minY + box.maxY) / 2
  let sx = 1
  let sy = 1
  if (dir.includes('e')) sx = Math.max(MIN_SCALE, (current[0] - anchorX) / w0)
  else if (dir.includes('w')) sx = Math.max(MIN_SCALE, (anchorX - current[0]) / w0)

  if (dir.includes('n')) sy = Math.max(MIN_SCALE, (current[1] - anchorY) / h0)
  else if (dir.includes('s')) sy = Math.max(MIN_SCALE, (anchorY - current[1]) / h0)

  if (uniform) {
    const ratio = dir === 'n' || dir === 's' ? sy : dir === 'e' || dir === 'w' ? sx : (sx + sy) / 2
    sx = ratio
    sy = ratio
  }
  return { fn: (x, y): Pt => [anchorX + (x - anchorX) * sx, anchorY + (y - anchorY) * sy], scaleFactor: (sx + sy) / 2 }
}

// 핸들을 start에서 current까지 끌었을 때의 점 변환. 변형 방식에 따라 크기·회전·기울임·왜곡 중 하나를 만든다.
// scaleFactor는 획 폭을 함께 키우는 데 쓴다(이동·회전·기울임은 1).
export function dragTransform(
  mode: TransformMode,
  box: BBox,
  dir: HandleDir,
  start: Pt,
  current: Pt,
  shiftKey: boolean,
): { fn: PointMap; scaleFactor: number } {
  if (mode === 'rotate') return { fn: rotateMap([(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2], start, current, shiftKey), scaleFactor: 1 }
  if (mode === 'skew') return { fn: skewMap(box, dir, start, current), scaleFactor: 1 }
  if (mode === 'distort') {
    const { map, areaRatio } = distortMap(box, dir, start, current)
    return { fn: map, scaleFactor: Math.sqrt(areaRatio) }
  }
  return scaleMap(box, dir, current, shiftKey)
}
