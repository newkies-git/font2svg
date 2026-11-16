import { warnOnce } from '../src/lib/log.ts'
import { FETCH_TIMEOUT_MS, MEDIAN_MIN_POINTS } from '../src/lib/constants.ts'
import { recoverMedian } from '../src/lib/strokeCut.ts'
import type { Pt } from '../src/types.ts'
import { parseNaverSvg } from './animSvg.ts'
import { IDS_OPERATOR } from './ids.ts'

export const HANJA_VERSION = 'hanzi-writer-data@2.0'

// AnimCJK: 커밋을 고정해 한 번만 내려받아 database/에 두고(저장소에는 올리지 않는다), 글자별 원본은 reference_data에 둔다.
// 일본(Ja) → 대만(ZhHant) → 한국(Ko) 순으로 덮어쓰므로 뒤에 있는 Ko가 가장 우선한다.
const ACJK_COMMIT = '1c8c8ef45aa9dfe1e1129cb5462ddf59a50a65ce'
export const ACJK_VERSION = `animCJK@${ACJK_COMMIT.slice(0, 10)}`
export const ACJK_RAW = `https://raw.githubusercontent.com/parsimonhi/animCJK/${ACJK_COMMIT}`
export const ACJK_BLOB = `https://github.com/parsimonhi/animCJK/blob/${ACJK_COMMIT}`
export const ACJK_VARIANTS = ['Ja', 'ZhHant', 'Ko']
// 네이버 한자사전: 한국 한자 획순 팝업('획순 보기')이 쓰는 글자별 애니메이션 SVG. 글자별로 필요할 때 하나씩 받고 원본 SVG를 reference_data에 둔다.
// 폴더는 코드의 앞 두 자리 + '00'이다(U+65E6 → 6500/65E6.svg). 배포 폴더명(aniSVG_연_월)이 바뀌면 NAVER_VERSION만 고치면 된다.
export const NAVER_VERSION = 'aniSVG_2026_04'
const NAVER_BASE = `https://ssl.pstatic.net/dicimg/cckodict/${NAVER_VERSION}`
const HANJA_CDN = 'https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0'
const KIBIBYTE = 1024
const FETCH_LIMIT = 512 * KIBIBYTE


export type Remote<T> = { url: string; raw: string; value: T | null }
// 값이 있다고 확인된 결과.
export type Found<T> = Remote<T> & { value: T }
export type HanjaGlyph = { medians: Pt[][]; outlines: string[]; radical: number[] }

// Hanja 중심선이 없거나 점이 모자라면 그 획의 윤곽에서 직접 계산한다. 계산도 실패하면 null.
export function medianOrRecovered(median: Pt[] | undefined, outline: string | undefined): Pt[] | null {
  if (median && median.length >= MEDIAN_MIN_POINTS) return median
  if (!outline) return null
  const recovered = recoverMedian(outline).median.map((point): Pt => [point.x, point.y])
  return recovered.length >= MEDIAN_MIN_POINTS ? recovered : null
}

export function hanjaStrokes(glyph: HanjaGlyph): { medians: Pt[][]; outlines: string[] } | null {
  const count = glyph.outlines.length || glyph.medians.length
  const medians: Pt[][] = []
  const outlines: string[] = []
  for (let index = 0; index < count; index++) {
    const median = medianOrRecovered(glyph.medians[index], glyph.outlines[index])
    if (!median) return null
    medians.push(median)
    outlines.push(glyph.outlines[index] ?? '')
  }
  return { medians, outlines }
}

export function hanjaUrl(char: string): string {
  return `${HANJA_CDN}/${encodeURIComponent(char)}.json`
}

export async function fetchHanja(char: string): Promise<Remote<HanjaGlyph>> {
  const url = hanjaUrl(char)
  const response = await fetchLimited(url)
  if (response.status === 404) return { url, raw: '', value: null }
  if (!response.ok) throw new Error(`Hanja 응답 ${response.status}`)
  return { url, raw: response.text, value: parseHanja(response.text) }
}

export function naverUrl(char: string): string {
  const hex = char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')
  return `${NAVER_BASE}/${hex.slice(0, -2)}00/${hex}.svg`
}

// 없는 글자는 404다. SVG가 아니거나 다른 글자의 것이면 던진다(없는 글자로 기록하지 않기 위해).
export async function fetchNaver(char: string): Promise<Remote<HanjaGlyph>> {
  const url = naverUrl(char)
  const response = await fetchLimited(url)
  if (response.status === 404) return { url, raw: '', value: null }
  if (!response.ok) throw new Error(`네이버 한자사전 응답 ${response.status}`)
  const { char: found, ...value } = parseNaverSvg(response.text)
  if (found !== char) throw new Error(`네이버 한자사전 SVG의 글자(${found})가 요청한 글자(${char})와 다릅니다.`)
  return { url, raw: response.text, value }
}

export function parseHanja(text: string): HanjaGlyph | null {
  try {
    if (text.trimStart().startsWith('<')) {
      const { medians, outlines, radical } = parseNaverSvg(text)
      return { medians, outlines, radical }
    }
    const data = JSON.parse(text) as { medians?: unknown; strokes?: unknown; outlines?: unknown; radStrokes?: unknown; radical?: unknown; acjk?: unknown }
    const medians = Array.isArray(data.medians) ? data.medians.map(asPoints) : []
    const strokeList = Array.isArray(data.strokes) ? data.strokes : data.outlines
    const outlines = Array.isArray(strokeList) ? strokeList.filter((item): item is string => typeof item === 'string') : []
    const radicalSource = Array.isArray(data.radStrokes) ? data.radStrokes : data.radical
    const radical = Array.isArray(radicalSource) ? radicalSource.map(Number).filter(Number.isInteger)
      : typeof data.acjk === 'string' ? radicalStrokes(data.acjk, medians.length) : []
    return medians.length || outlines.length ? { medians, outlines, radical } : null
  } catch (error) {
    // 저장된 레퍼런스 원문을 해석하지 못함(형식이 바뀌었을 수 있다). 없는 것으로 취급한다.
    warnOnce('parseHanja', error)
    return null
  }
}

// AnimCJK 분해식(acjk)에서 부수 표시('.')가 붙은 부품의 획 번호(0부터)를 구한다. 부품은 그리는 순서대로 적혀 있으므로,
// 구조 기호는 건너뛰고 '글자 + 표시 + 획수'를 차례로 읽어 획수를 누적한다. 예: 近⿺斤4辶.4 → [4, 5, 6, 7].
// 첫 글자(풀이하는 글자)에 '.'가 있으면 글자 전체가 부수다. 해석하지 못하거나 획수 합이 맞지 않으면 빈 배열.
function radicalStrokes(acjk: string, total: number): number[] {
  const tokens = [...acjk]
  let pos = 1
  // 글자 뒤의 표시를 읽고 '.'가 있었는지 돌려준다. '~' 다음 글자는 같은 부품을 뜻하는 다른 글자, ':'·'::'는 나뉨·겹침(뒤의 영문자는 구분용).
  const readMarks = (): boolean => {
    let radical = false
    for (;;) {
      const token = tokens[pos]
      if (token === '.') {
        radical = true
        pos += 1
      } else if (token === '~') {
        pos += 2
      } else if (token === ':') {
        pos += tokens[pos + 1] === ':' || /[a-z]/.test(tokens[pos + 1] ?? '') ? 2 : 1
      } else return radical
    }
  }
  if (readMarks()) return Array.from({ length: total }, (_, index) => index)
  const radical: number[] = []
  let count = 0
  while (pos < tokens.length) {
    if (IDS_OPERATOR.test(tokens[pos++])) continue
    const marked = readMarks()
    if (tokens[pos] >= '0' && tokens[pos] <= '9') {
      let strokes = 0
      while (tokens[pos] >= '0' && tokens[pos] <= '9') strokes = strokes * 10 + Number(tokens[pos++])
      if (marked) for (let index = 0; index < strokes; index++) radical.push(count + index)
      count += strokes
    } else if (marked && IDS_OPERATOR.test(tokens[pos] ?? '')) return []
  }
  return count === total ? radical : []
}

function asPoints(value: unknown): Pt[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((point) => {
    if (!Array.isArray(point) || point.length < 2) return []
    const x = Number(point[0])
    const y = Number(point[1])
    return Number.isFinite(x) && Number.isFinite(y) ? [[x, y] as Pt] : []
  })
}

export async function fetchLimited(url: string, limit = FETCH_LIMIT): Promise<{ status: number; ok: boolean; text: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const text = await response.text()
  if (text.length > limit) throw new Error('응답이 너무 큽니다.')
  return { status: response.status, ok: response.ok, text }
}
