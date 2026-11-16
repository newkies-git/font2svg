import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after } from 'node:test'
import { loadFont } from '../server/font.ts'
import { drawRect, tempDir, writeTestFont } from './helpers.ts'

const dir = tempDir()
after(() => fs.rmSync(dir, { recursive: true, force: true }))

const file = path.join(dir, 'test.ttf')
writeTestFont(file, [
  { char: '一', draw: (p) => drawRect(p, 100, 300, 900, 400) },
  { char: '二', draw: (p) => { drawRect(p, 100, 300, 900, 400); drawRect(p, 100, 600, 900, 700) } },
  {
    char: '曲',
    draw: (p) => {
      p.moveTo(100, 100)
      p.curveTo(300, 900, 700, 900, 900, 100)
      p.curveTo(700, 0, 300, 0, 100, 100)
      p.close()
    },
  },
])

const numbersOf = (d: string) => (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 0.2, `${actual} ≈ ${expected}`)

test('폰트 파일이 없으면 null, 깨진 파일이면 읽을 수 없다고 던진다', () => {
  assert.equal(loadFont(path.join(dir, 'none.ttf')), null)
  const broken = path.join(dir, 'broken.ttf')
  fs.writeFileSync(broken, 'not a font')
  assert.throws(() => loadFont(broken), /TTF 파일을 읽을 수 없습니다/)
})

test('해시와 글꼴 단위를 읽는다', () => {
  const font = loadFont(file)!
  assert.match(font.sha256, /^[0-9a-f]{64}$/)
  assert.equal(font.unitsPerEm, 1000)
  assert.equal(loadFont(file)!.sha256, font.sha256, '같은 파일은 같은 해시')
})

test('윤곽 좌표: 1024 캔버스로 키우고 y축은 위쪽, 기준선만큼 올린다', () => {
  const [contour] = loadFont(file)!.contours('一')!
  assert.match(contour, /^M .* Z$/)
  const xs = numbersOf(contour).filter((_, i) => i % 2 === 0)
  const ys = numbersOf(contour).filter((_, i) => i % 2 === 1)
  near(Math.min(...xs), 102.4)
  near(Math.max(...xs), 921.6)
  // y = 글꼴 y × 1.024 + 95(BASELINE_SHIFT)
  near(Math.min(...ys), 300 * 1.024 + 95)
  near(Math.max(...ys), 400 * 1.024 + 95)
})

test('윤곽이 여러 개인 글자는 윤곽마다 경로 하나', () => {
  assert.equal(loadFont(file)!.contours('二')!.length, 2)
})

// opentype.js가 만드는 시험용 폰트는 CFF(3차 곡선)라 2차 곡선(Q) 분기는 실제 TrueType 폰트가 있어야 검증된다.
test('곡선 명령(C)도 경로로 옮긴다', () => {
  const [contour] = loadFont(file)!.contours('曲')!
  assert.match(contour, / C /)
  assert.match(contour, /Z$/)
})

test('글리프가 없는 글자는 null', () => {
  assert.equal(loadFont(file)!.contours('三'), null)
})
