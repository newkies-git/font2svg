import { warnOnce } from '../shared/log.ts'
import { FETCH_TIMEOUT_MS, MEDIAN_MIN_POINTS } from '../shared/constants.ts'
import { recoverMedian } from '../shared/strokeCut.ts'
import type { Pt } from '../shared/types.ts'
import { parseNaverSvg } from './animSvg.ts'

export const HANJA_VERSION = 'hanzi-writer-data@2.0'

// 네이버 한자사전: 한국 한자 획순 팝업('획순 보기')이 쓰는 글자별 애니메이션 SVG. 원본 SVG는 reference_data에 둔다(일괄 수신은 scripts/prefetchReferences.ts).
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

// 네이버는 일부 글자를 호환 한자 코드(U+F900대 등)로 저장한다. 예: 금으로 읽는 金은 U+F90A(정규화하면 U+91D1)에 있고 U+91D1에는 없다.
const COMPAT_RANGES: readonly (readonly [number, number])[] = [[0xf900, 0xfaff], [0x2f800, 0x2fa1f]]
let compatIndex: Map<string, string[]> | undefined

// char와 같은 글자로 정규화되는 호환 한자들.
function compatVariants(char: string): string[] {
  if (!compatIndex) {
    compatIndex = new Map()
    for (const [from, to] of COMPAT_RANGES) {
      for (let code = from; code <= to; code++) {
        const variant = String.fromCodePoint(code)
        const base = variant.normalize('NFC')
        if (base === variant) continue
        compatIndex.set(base, [...(compatIndex.get(base) ?? []), variant])
      }
    }
  }
  return compatIndex.get(char.normalize('NFC')) ?? []
}

// 없는 글자는 404다(호환 한자 코드도 모두 404일 때). SVG가 아니거나 다른 글자의 것이면 던진다(없는 글자로 기록하지 않기 위해).
export async function fetchNaver(char: string): Promise<Remote<HanjaGlyph>> {
  for (const candidate of new Set([char, ...compatVariants(char)])) {
    const url = naverUrl(candidate)
    const response = await fetchLimited(url)
    if (response.status === 404) continue
    if (!response.ok) throw new Error(`네이버 한자사전 응답 ${response.status}`)
    const { char: found, ...value } = parseNaverSvg(response.text)
    if (found.normalize('NFC') !== char.normalize('NFC')) throw new Error(`네이버 한자사전 SVG의 글자(${found})가 요청한 글자(${char})와 다릅니다.`)
    return { url, raw: response.text, value }
  }
  return { url: naverUrl(char), raw: '', value: null }
}

export function parseHanja(text: string): HanjaGlyph | null {
  try {
    if (text.trimStart().startsWith('<')) {
      const { medians, outlines, radical } = parseNaverSvg(text)
      return { medians, outlines, radical }
    }
    const data = JSON.parse(text) as { medians?: unknown; strokes?: unknown; outlines?: unknown; radStrokes?: unknown; radical?: unknown }
    const medians = Array.isArray(data.medians) ? data.medians.map(asPoints) : []
    const strokeList = Array.isArray(data.strokes) ? data.strokes : data.outlines
    const outlines = Array.isArray(strokeList) ? strokeList.filter((item): item is string => typeof item === 'string') : []
    const radicalSource = Array.isArray(data.radStrokes) ? data.radStrokes : data.radical
    const radical = Array.isArray(radicalSource) ? radicalSource.map(Number).filter(Number.isInteger) : []
    return medians.length || outlines.length ? { medians, outlines, radical } : null
  } catch (error) {
    // 저장된 레퍼런스 원문을 해석하지 못함(형식이 바뀌었을 수 있다). 없는 것으로 취급한다.
    warnOnce('parseHanja', error)
    return null
  }
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

async function fetchLimited(url: string, limit = FETCH_LIMIT): Promise<{ status: number; ok: boolean; text: string }> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  const text = await response.text()
  if (text.length > limit) throw new Error('응답이 너무 큽니다.')
  return { status: response.status, ok: response.ok, text }
}
