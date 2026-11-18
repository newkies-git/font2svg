import assert from 'node:assert/strict'
import test from 'node:test'
import { animatedSvg, parseAnimSvg, parseNaverSvg } from '../server/animSvg.ts'

// 윤곽은 y=900-SVG y로 뒤집힌다(ACJK_SVG_Y_ORIGIN).
const ACJK = `<svg id="z19968" viewBox="0 0 1024 1024">
<path id="z19968d1" d="M 100 800 H 300 V 700 L 100 700 z"/>
<path pathLength="3333" clip-path="url(#z19968c1)" d="M 110 750 L 290 750"/>
</svg>`

test('AnimCJK SVG에서 윤곽과 중심선을 읽고 y를 뒤집는다', () => {
  const { outlines, medians } = parseAnimSvg(ACJK, '一')
  assert.deepEqual(outlines, ['M 100 100 L 300 100 L 300 200 L 100 200 Z'])
  assert.deepEqual(medians, [[[110, 150], [290, 150]]])
})

test('AnimCJK: 다른 글자·빈 SVG·개수 불일치를 거부한다', () => {
  assert.throws(() => parseAnimSvg(ACJK, '二'), /다릅니다/)
  assert.throws(() => parseAnimSvg('<p>x</p>', '一'), /SVG 파일이 아닙니다/)
  assert.throws(() => parseAnimSvg('<svg id="z19968"></svg>', '一'), /획 윤곽/)
  const noMedian = ACJK.replace(/<path pathLength[^>]*>/, '')
  assert.throws(() => parseAnimSvg(noMedian, '一'), /수가 다릅니다/)
})

test('AnimCJK: 지원하지 않는 경로 명령을 거부한다', () => {
  const relative = ACJK.replace('M 100 800 H 300', 'm 100 800 h 300')
  assert.throws(() => parseAnimSvg(relative, '一'), /지원하지 않는/)
})

const NAVER = `<svg id="U4E01ani" xmlns="http://www.w3.org/2000/svg">
<g transform="scale(1,-1) translate(0, -900)">
<path id="U4E01d2" d="M 0 0 L 10 0 L 10 10 Z"/>
<path id="U4E01d1" class="stroke-radical" d="M 20 20 L 30 20 L 30 30 Z"/>
<path clip-path="url(#U4E01c2)" d="M 1 1 L 9 9"/>
<path clip-path="url(#U4E01c1)" d="M 21 21 L 29 29"/>
</g></svg>`

test('네이버 SVG는 번호 순으로 정렬하고 부수 획을 표시한다', () => {
  const parsed = parseNaverSvg(NAVER)
  assert.equal(parsed.char, '丁')
  assert.deepEqual(parsed.outlines, ['M 20 20 L 30 20 L 30 30 Z', 'M 0 0 L 10 0 L 10 10 Z'])
  assert.deepEqual(parsed.medians, [[[21, 21], [29, 29]], [[1, 1], [9, 9]]])
  assert.deepEqual(parsed.radical, [0])
})

test('네이버 SVG: 루트 id·좌표 변환·번호 누락을 검사한다', () => {
  assert.throws(() => parseNaverSvg('<svg id="x"></svg>'), /네이버 한자사전 SVG가 아닙니다/)
  assert.throws(() => parseNaverSvg(NAVER.replace(/<g [^>]*>/, '<g>')), /좌표 변환/)
  assert.throws(() => parseNaverSvg(NAVER.replace('U4E01d2', 'U4E01d3').replace('U4E01c2', 'U4E01c3')), /이어지지 않습니다/)
})

test('animatedSvg 골든: 구조와 획별 속성', () => {
  const svg = animatedSvg('U+4E00', ['M 0 0 L 1 0 L 1 1 Z', 'M 2 2 L 3 2 L 3 3 Z'], [[[0, 0], [5, 5]], [[1, 1], [2, 2], [3, 3]]], [80, 90])
  assert.match(svg, /^<svg id="z19968" class="acjk" viewBox="0 0 1024 1024"/)
  assert.match(svg, /<path id="z19968d1" d="M 0 0 L 1 0 L 1 1 Z"\/>/)
  assert.match(svg, /<clipPath id="z19968c2"><use href="#z19968d2"\/><\/clipPath>/)
  assert.match(svg, /style="--d:0s;stroke-width:80" pathLength="3333" clip-path="url\(#z19968c1\)" d="M0 0L5 5"/)
  assert.match(svg, /style="--d:1s;stroke-width:90" pathLength="3333" clip-path="url\(#z19968c2\)" d="M1 1L2 2L3 3"/)
  assert.ok(svg.endsWith('</svg>\n'))
})

test('animatedSvg 결과를 parseAnimSvg가 같은 좌표로 다시 읽는다(왕복)', () => {
  const outlines = ['M 100 400 L 900 400 L 900 520 L 100 520 Z', 'M 480 100 L 560 100 L 560 950 L 480 950 Z']
  const medians: [number, number][][] = [[[150, 460], [870, 460]], [[520, 120], [520, 930.5]]]
  const parsed = parseAnimSvg(animatedSvg('U+4E00', outlines, medians, [80, 90]), '一')
  assert.deepEqual(parsed.outlines, outlines)
  assert.deepEqual(parsed.medians, medians)
})

test('그룹 변환이 없는 AnimCJK 파일은 계속 y = 900 - SVG y로 읽는다', () => {
  const svg = '<svg id="z19968"><path id="z19968d1" d="M 100 500 L 900 500 L 900 380 Z"/><path pathLength="3333" clip-path="url(#z19968c1)" d="M 100 450 L 900 450"/></svg>'
  const parsed = parseAnimSvg(svg, '一')
  assert.equal(parsed.outlines[0], 'M 100 400 L 900 400 L 900 520 Z')
  assert.deepEqual(parsed.medians[0], [[100, 450], [900, 450]])
})
