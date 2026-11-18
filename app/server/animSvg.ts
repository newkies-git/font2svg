import { ACJK_SVG_Y_ORIGIN, ANIM_PATH_LENGTH, ANIM_STROKE_SECONDS, ANIM_STROKE_STEP_SECONDS, CANVAS, COORD_ROUND } from '../shared/constants.ts'
import type { Pt } from '../shared/types.ts'
type Segment = { command: string; values: number[] }

// 명령별 인자 수. AnimCJK SVG가 쓰는 절대 좌표 명령만 받는다.
const ARGUMENT_COUNT: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, Q: 4, C: 6 }

const round = (value: number) => Math.round(value * COORD_ROUND) / COORD_ROUND

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [, name, value] of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) result[name] = value
  return result
}

// makeGraphicsFromSvgs.php의 경로 정리와 같다: H/V는 L로, z는 Z로, 생략된 반복 명령은 채운다.
function segmentsOf(d: string): Segment[] {
  const tokens = d.match(/[A-Za-z]|[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []
  const segments: Segment[] = []
  let current: Pt = [0, 0]
  let start: Pt = [0, 0]
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index++]
    if (!/^[A-Za-z]$/.test(token)) throw new Error(`경로의 명령을 알 수 없습니다: ${token}`)
    const command = token === 'z' ? 'Z' : token
    if (command === 'Z') {
      segments.push({ command: 'Z', values: [] })
      current = start
      continue
    }
    const count = ARGUMENT_COUNT[command]
    if (!count) throw new Error(`지원하지 않는 경로 명령입니다: ${token} (절대 좌표 M L H V Q C Z만 쓸 수 있습니다)`)
    let repeated = command
    do {
      const values = tokens.slice(index, index + count).map(Number)
      if (values.length < count || values.some((value) => !Number.isFinite(value))) throw new Error('경로의 좌표가 올바르지 않습니다.')
      index += count
      const end: Pt = repeated === 'H' ? [values[0], current[1]] : repeated === 'V' ? [current[0], values[0]] : [values[count - 2], values[count - 1]]
      if (repeated === 'M') start = end
      const normalized = repeated === 'H' || repeated === 'V' ? 'L' : repeated
      segments.push({ command: normalized, values: normalized === 'L' ? end : values })
      current = end
      // M 뒤에 이어지는 좌표쌍은 L이다.
      repeated = repeated === 'M' ? 'L' : repeated
    } while (index < tokens.length && !/^[A-Za-z]$/.test(tokens[index]))
  }
  return segments
}

type Mapper = (x: number, y: number) => Pt

// AnimCJK SVG는 y가 아래로 늘어나므로 뒤집는다.
const flipY = (y: number) => round(ACJK_SVG_Y_ORIGIN - y)
const fromAnimCjk: Mapper = (x, y) => [round(x), flipY(y)]
// 우리가 내보내는 SVG(animatedSvg)는 경로에 저장 좌표(y축 위쪽)를 그대로 적고 이 변환으로 그룹을 뒤집어 그린다.
// 이 변환이 있으면 경로의 숫자가 이미 저장 좌표이므로 다시 뒤집지 않는다.
const STORED_COORDS_TRANSFORM = `translate(0 ${CANVAS}) scale(1 -1)`
const fromStored: Mapper = (x, y) => [round(x), round(y)]
const hasStoredCoords = (svg: string) => svg.includes(`transform="${STORED_COORDS_TRANSFORM}"`)

function outlinePath(d: string, map: Mapper): string {
  return segmentsOf(d).map(({ command, values }) => {
    const mapped: number[] = []
    for (let i = 0; i < values.length; i += 2) mapped.push(...map(values[i], values[i + 1]))
    return [command, ...mapped].join(' ')
  }).join(' ')
}

function medianPoints(d: string, map: Mapper): Pt[] {
  return segmentsOf(d).map(({ command, values }) => {
    if (command !== 'M' && command !== 'L') throw new Error('중심선은 M과 L로만 이루어져야 합니다.')
    return map(values[0], values[1])
  })
}

// AnimCJK 형식 SVG(makeSvgsFromGraphics.php가 만드는 모양)에서 획 윤곽과 중심선을 읽는다. 우리가 내보낸 SVG(animatedSvg)도 읽으며, 그때는 좌표를 뒤집지 않는다.
// 좌표 규칙: 숫자가 SVG 좌표(y 아래쪽)인 AnimCJK 파일은 y = 900 - SVG y, 우리 파일은 숫자 그대로 저장 좌표다.
// 윤곽은 id="z{코드}d{획}[a-z]" 경로, 중심선은 pathLength가 있는 경로이고 둘 다 문서 순서가 획 순서다.
// 쪼개진 획(접미사 a, b)은 원본 스크립트처럼 각각 별개의 획으로 가져온다.
export function parseAnimSvg(svg: string, char: string): { outlines: string[]; medians: Pt[][] } {
  const root = /<svg\b[^>]*>/i.exec(svg)
  if (!root) throw new Error('SVG 파일이 아닙니다.')
  const codePoint = char.codePointAt(0)
  const rootId = attributes(root[0]).id
  if (rootId && rootId !== `z${codePoint}`) throw new Error(`SVG의 글자(${rootId})가 선택한 글자(${char})와 다릅니다.`)

  const map = hasStoredCoords(svg) ? fromStored : fromAnimCjk
  const outlines: string[] = []
  const medians: Pt[][] = []
  for (const [tag] of svg.matchAll(/<path\b[^>]*>/gi)) {
    const attribute = attributes(tag)
    if (!attribute.d) continue
    if (attribute.id && /^z\d+d\d+[a-z]?$/.test(attribute.id)) outlines.push(outlinePath(attribute.d, map))
    else if (attribute.pathLength) medians.push(medianPoints(attribute.d, map))
  }
  if (outlines.length === 0) throw new Error('SVG에서 획 윤곽(id="z…d…")을 찾지 못했습니다.')
  if (outlines.length !== medians.length) throw new Error(`획 윤곽 ${outlines.length}개와 중심선 ${medians.length}개의 수가 다릅니다.`)
  return { outlines, medians }
}

// 네이버 한자사전(한국 한자 획순)의 애니메이션 SVG에서 획 윤곽·중심선·부수 여부를 읽는다.
// 윤곽은 id="U{코드}d{획 번호}"(class가 stroke-radical이면 부수), 중심선은 clip-path="url(#U{코드}c{획 번호})"인 경로다.
// 번호가 획순이다(문서 안의 순서는 획순이 아니다). 좌표는 <g transform="scale(1,-1) translate(tx, ty)"> 안에 있으므로
// 화면 y = -ty - y 이고, 저장 좌표계(화면 y = ACJK_SVG_Y_ORIGIN - y)로 옮기면 y' = ACJK_SVG_Y_ORIGIN + ty + y, x' = x + tx이다.
// 글자는 루트 id(U{코드}ani)에서 읽어 돌려주므로, 부른 쪽이 찾던 글자와 같은지 확인해야 한다.
export function parseNaverSvg(svg: string): { char: string; outlines: string[]; medians: Pt[][]; radical: number[] } {
  const root = /<svg\b[^>]*>/i.exec(svg)
  if (!root) throw new Error('SVG 파일이 아닙니다.')
  const prefix = /^(U[0-9A-F]{4,6})ani$/.exec(attributes(root[0]).id ?? '')?.[1]
  if (!prefix) throw new Error('네이버 한자사전 SVG가 아닙니다(루트 id가 U{코드}ani가 아닙니다).')
  const char = String.fromCodePoint(Number.parseInt(prefix.slice(1), 16))
  const shift = /<g\b[^>]*transform="scale\(1,\s*-1\)\s*translate\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)"/.exec(svg)
  if (!shift) throw new Error('SVG의 좌표 변환을 찾지 못했습니다.')
  const [tx, ty] = [Number(shift[1]), Number(shift[2])]
  const map: Mapper = (x, y) => [round(x + tx), round(ACJK_SVG_Y_ORIGIN + ty + y)]

  const outlines = new Map<number, { path: string; radical: boolean }>()
  const medians = new Map<number, Pt[]>()
  for (const [tag] of svg.matchAll(/<path\b[^>]*>/gi)) {
    const attribute = attributes(tag)
    if (!attribute.d) continue
    const outline = attribute.id?.match(new RegExp(`^${prefix}d(\\d+)$`))
    const median = attribute['clip-path']?.match(new RegExp(`^url\\(#${prefix}c(\\d+)\\)$`))
    if (outline) outlines.set(Number(outline[1]), { path: outlinePath(attribute.d, map), radical: attribute.class === 'stroke-radical' })
    else if (median) medians.set(Number(median[1]), medianPoints(attribute.d, map))
  }
  if (outlines.size === 0) throw new Error('SVG에서 획 윤곽(id="U…d…")을 찾지 못했습니다.')
  if (outlines.size !== medians.size) throw new Error(`획 윤곽 ${outlines.size}개와 중심선 ${medians.size}개의 수가 다릅니다.`)
  const order = [...outlines.keys()].sort((a, b) => a - b)
  if (order.some((number, index) => number !== index + 1 || !medians.has(number))) throw new Error('획 번호가 1부터 이어지지 않습니다.')
  return {
    char,
    outlines: order.map((number) => outlines.get(number)!.path),
    medians: order.map((number) => medians.get(number)!),
    radical: order.flatMap((number, index) => (outlines.get(number)!.radical ? [index] : [])),
  }
}

// AnimCJK 방식 애니메이션 SVG: 획 윤곽을 clipPath로 쓰고, 그 위에 중심선을 점선으로 그려 점선 위치를 옮긴다.
// 저장 좌표(y축 위쪽)를 뷰어와 같이 뒤집어 그린다. 획마다 폭이 달라 stroke-width를 획별로 준다.
export function animatedSvg(unicode: string, outlines: string[], medians: Pt[][], widths: number[]): string {
  const id = `z${Number.parseInt(unicode.slice(2), 16)}`
  const dash = ANIM_PATH_LENGTH + 4
  const fills = outlines.map((outline, index) => `<path id="${id}d${index + 1}" d="${outline}"/>`).join('\n')
  const clips = outlines.map((_, index) => `<clipPath id="${id}c${index + 1}"><use href="#${id}d${index + 1}"/></clipPath>`).join('\n')
  const lines = medians.map((median, index) => {
    const d = median.map(([x, y], pointIndex) => `${pointIndex === 0 ? 'M' : 'L'}${x} ${y}`).join('')
    return `<path style="--d:${index * ANIM_STROKE_STEP_SECONDS}s;stroke-width:${widths[index]}" pathLength="${ANIM_PATH_LENGTH}" clip-path="url(#${id}c${index + 1})" d="${d}"/>`
  }).join('\n')
  return `<svg id="${id}" class="acjk" viewBox="0 0 ${CANVAS} ${CANVAS}" xmlns="http://www.w3.org/2000/svg">
<style>
<![CDATA[
@keyframes zk { to { stroke-dashoffset:0; } }
svg.acjk path[clip-path] { --t:${ANIM_STROKE_SECONDS}s; animation:zk var(--t) linear forwards var(--d); stroke-dasharray:${dash}; stroke-dashoffset:${dash + 2}; stroke-linecap:round; fill:none; stroke:#000; }
svg.acjk path[id] { fill:#ccc; }
]]>
</style>
<g transform="${STORED_COORDS_TRANSFORM}">
${fills}
<defs>
${clips}
</defs>
${lines}
</g>
</svg>
`
}
