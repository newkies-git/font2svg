import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { BENCH_SAMPLE_SIZE, CANVAS, LAYER_ID } from '../shared/constants.ts'
import { measureExtraction, measureOutline, summarizeExtraction, type CharMeasure } from '../server/extractMetrics.ts'
import { loadFont } from '../server/font.ts'
import { orderedGlyph } from '../server/referenceMerge.ts'
import { parseHanja } from '../server/references.ts'
import { fitGuideToFont } from '../server/geometry.ts'
import type { Pt } from '../shared/types.ts'

// 궁서체 윤곽에 참고 중심선(획순 NAVER, 모양 Hanzi)을 맞춰 획을 나눈 결과를 숫자로 잰다. DB는 읽기만 한다.
// 사람이 그린 참고 윤곽(Hanzi)을 기준선으로 같이 보여, 추출 결과가 얼마나 다른지 본다.
// 사용법: npm run bench:extract [-- --size 200] [-- --out 결과.json] [-- --sheet 접촉시트.svg]
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const rootDir = path.join(appDir, '..')
const args = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`)
  return index === -1 ? undefined : args[index + 1]
}
const SHEET_PALETTE = ['#d94841', '#2f7fd1', '#2e9e5b', '#c98a00', '#8a4fd1', '#14a3a3', '#d1478f', '#6b7280']
const SHEET_CELL = 160
const SHEET_COLUMNS = 10
const size = Number(option('size') ?? BENCH_SAMPLE_SIZE)
const outFile = option('out')
const sheetFile = option('sheet')

const font = loadFont(path.join(appDir, 'fonts', 'Gungseouche.ttf'))
if (!font) throw new Error('궁서체 폰트(app/fonts/Gungseouche.ttf)가 없습니다')
const db = new DatabaseSync(path.join(rootDir, 'database', 'chusa1817.db'), { readOnly: true })

// 길잡이는 실제 쓰는 방식과 같게 만든다: 획순은 NAVER, 모양은 Hanzi(획 수가 다르거나 Hanzi가 없으면 NAVER). NAVER가 없는 글자는 뺀다.
const rows = db.prepare(`SELECT c.char, r.source, r.raw_data FROM characters c JOIN reference_data r ON r.unicode = c.unicode WHERE r.found = 1 AND r.source IN ('NAVER', 'MMH') ORDER BY c.unicode`).all() as { char: string; source: string; raw_data: string }[]
const best = new Map<string, { NAVER?: string; MMH?: string }>()
for (const row of rows) best.set(row.char, { ...best.get(row.char), [row.source]: row.raw_data })
for (const [char, sources] of best) if (!sources.NAVER) best.delete(char)
const candidates = [...best.keys()]
// 앞에서부터 고르게 size자를 뽑는다(같은 입력이면 같은 표본이라 전후 비교가 된다).
const step = Math.max(1, Math.floor(candidates.length / size))
const sample = candidates.filter((_, index) => index % step === 0).slice(0, size)

const referenceVertices: number[] = []
const referenceCurveRatios: number[] = []
const referenceMedians: Pt[][] = []
const measures: CharMeasure[] = []
const sheet: { char: string; outlines: string[] }[] = []
const started = Date.now()
for (const char of sample) {
  const contours = font.contours(char)
  const sources = best.get(char)!
  const naver = parseHanja(sources.NAVER!)
  const guide = naver && orderedGlyph(naver, sources.MMH ? parseHanja(sources.MMH) : null)
  if (!contours || !guide) continue
  for (const outline of guide.outlines) {
    const counted = measureOutline(outline)
    referenceVertices.push(counted.vertices)
    referenceCurveRatios.push(counted.curveRatio)
  }
  referenceMedians.push(...guide.medians)
  measures.push(measureExtraction(char, contours, guide.medians, guide.outlines))
  if (sheetFile) sheet.push({ char, outlines: fitGuideToFont(contours, guide.medians, guide.outlines)?.outlines ?? [] })
}
const summary = { ...summarizeExtraction(measures, { vertices: referenceVertices, curveRatios: referenceCurveRatios, medians: referenceMedians }), seconds: Number(((Date.now() - started) / 1000).toFixed(1)), referenceShape: 'MMH', referenceOrder: LAYER_ID.naver }
console.log(JSON.stringify(summary, null, 2))
if (outFile) fs.writeFileSync(outFile, JSON.stringify(summary, null, 2) + '\n')
if (sheetFile) fs.writeFileSync(sheetFile, contactSheet(sheet))

// 글자마다 획을 다른 색으로 칠해 한눈에 보는 접촉시트(SVG). 글자 칸은 SHEET_CELL 정사각형, 좌표는 0~CANVAS(y 위쪽)다.
function contactSheet(items: { char: string; outlines: string[] }[]): string {
  const palette = SHEET_PALETTE
  const cell = SHEET_CELL
  const columns = SHEET_COLUMNS
  const canvas = CANVAS
  const rowsCount = Math.ceil(items.length / columns)
  const cells = items.map((item, index) => {
    const x = (index % columns) * cell
    const y = Math.floor(index / columns) * cell
    const scale = cell / canvas
    const paths = item.outlines.map((d, i) => `<path d="${d}" fill="${palette[i % palette.length]}" fill-opacity=".75" stroke="#111" stroke-width="3"/>`).join('')
    return `<g transform="translate(${x} ${y})"><rect width="${cell}" height="${cell}" fill="#fff" stroke="#ddd"/><g transform="scale(${scale}) translate(0 ${canvas}) scale(1 -1)">${paths}</g></g>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${columns * cell}" height="${rowsCount * cell}">${cells.join('')}</svg>\n`
}
