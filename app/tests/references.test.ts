import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { fetchNaver, hanjaStrokes, hanjaUrl, medianOrRecovered, naverUrl, parseHanja } from '../server/references.ts'
import { rectPath } from './helpers.ts'

test('parseHanja: hanzi-writer JSON(medians/strokes/radStrokes)', () => {
  const glyph = parseHanja(JSON.stringify({ medians: [[[0, 0], [5, 5]]], strokes: ['M 0 0 Z'], radStrokes: [0] }))
  assert.deepEqual(glyph, { medians: [[[0, 0], [5, 5]]], outlines: ['M 0 0 Z'], radical: [0] })
})

test('parseHanja: outlines/radical 별칭과 비정상 값 걸러내기', () => {
  const glyph = parseHanja(JSON.stringify({ medians: [], outlines: ['M 0 0 Z', 7], radical: [1, 'x', 2.5] }))
  assert.deepEqual(glyph, { medians: [], outlines: ['M 0 0 Z'], radical: [1] })
})

test('parseHanja: 비어 있거나 깨진 입력은 null', () => {
  assert.equal(parseHanja('{}'), null)
  assert.equal(parseHanja('not json'), null)
})

test('parseHanja: 네이버 SVG는 SVG 파서로 보낸다', () => {
  const svg = `<svg id="U4E01ani"><g transform="scale(1,-1) translate(0, -900)">
<path id="U4E01d1" d="M 0 0 L 10 0 L 10 10 Z"/><path clip-path="url(#U4E01c1)" d="M 1 1 L 9 9"/></g></svg>`
  assert.deepEqual(parseHanja(svg), { medians: [[[1, 1], [9, 9]]], outlines: ['M 0 0 L 10 0 L 10 10 Z'], radical: [] })
})

test('URL 조립: 한자 CDN과 네이버 경로', () => {
  assert.equal(hanjaUrl('一'), `https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0/${encodeURIComponent('一')}.json`)
  assert.match(naverUrl('一'), /\/4E00\/4E00\.svg$/)
  assert.match(naverUrl('丁'), /\/4E00\/4E01\.svg$/)
})

test('medianOrRecovered: 충분한 중심선은 그대로, 없으면 윤곽에서 복원', () => {
  const median: [number, number][] = [[0, 0], [10, 10]]
  assert.equal(medianOrRecovered(median, undefined), median)
  assert.equal(medianOrRecovered(undefined, undefined), null)
  const recovered = medianOrRecovered(undefined, rectPath(100, 100, 500, 160))
  assert.ok(recovered && recovered.length >= 2)
})

test('hanjaStrokes: 중심선이 없는 획은 복원하고 복원 불가면 null', () => {
  const bar = rectPath(100, 100, 500, 160)
  const result = hanjaStrokes({ medians: [], outlines: [bar], radical: [] })
  assert.equal(result?.outlines[0], bar)
  assert.ok(result && result.medians[0].length >= 2)
  assert.equal(hanjaStrokes({ medians: [], outlines: [], radical: [] })?.medians.length, 0)
  assert.equal(hanjaStrokes({ medians: [[[0, 0]]], outlines: [], radical: [] }), null)
})

const naverSvgOf = (codePoint: number) => {
  const id = `U${codePoint.toString(16).toUpperCase()}`
  return `<svg id="${id}ani"><g transform="scale(1,-1) translate(0, -900)"><path id="${id}d1" d="M 0 0 L 10 0 L 10 10 Z"/><path clip-path="url(#${id}c1)" d="M 1 1 L 9 9"/></g></svg>`
}

test('fetchNaver: 기본 코드에 없으면 호환 한자 코드를 찾아 받고 실제로 받은 주소를 돌려준다', async () => {
  const requested: string[] = []
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input)
    requested.push(url)
    return url === naverUrl('\uF90A') ? new Response(naverSvgOf(0xf90a), { status: 200 }) : new Response('not found', { status: 404 })
  })
  try {
    const result = await fetchNaver('金')
    assert.equal(result.url, naverUrl('\uF90A'))
    assert.match(result.url, /\/F900\/F90A\.svg$/)
    assert.equal(result.value?.medians.length, 1)
    assert.equal(requested[0], naverUrl('金'))
  } finally {
    mock.restoreAll()
  }
})

test('fetchNaver: 호환 한자 코드까지 모두 404이면 없음이다', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('not found', { status: 404 }))
  try {
    const result = await fetchNaver('金')
    assert.equal(result.value, null)
    assert.equal(result.url, naverUrl('金'))
  } finally {
    mock.restoreAll()
  }
})

test('fetchNaver: 호환 한자가 없는 글자는 요청을 한 번만 한다', async () => {
  const requested: string[] = []
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requested.push(String(input))
    return new Response('not found', { status: 404 })
  })
  try {
    assert.equal((await fetchNaver('丁')).value, null)
    assert.equal(requested.length, 1)
  } finally {
    mock.restoreAll()
  }
})
