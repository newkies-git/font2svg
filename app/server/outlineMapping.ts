import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_STROKE_WIDTH, LAYER_ID } from '../shared/constants.ts'
import type { LayerRecord, StrokeRecord } from '../shared/types.ts'
import { contourIndicesOfOutline, contourLoopsOf, ribbonPath, splitOutlinePieces } from './geometry.ts'
import { fontContoursOf, fontFingerprint } from './layers.ts'
import { patchLayersMeta, saveNonStrokeLayerContent } from './layerWrites.ts'

const OUTLINE_LAYER_ID = LAYER_ID.outline
const SOURCE_FALLBACK_IDS = [LAYER_ID.naver, LAYER_ID.mmh, LAYER_ID.acjk] as const

// 중심선 길잡이로 쓸 레이어: 지정한 레이어 → 작업 획 → 네이버 → MMH → ACJK 순으로 획이 있는 첫 레이어.
function pickGuideLayer(layers: LayerRecord[], sourceLayerId?: string): LayerRecord {
  const ids = [sourceLayerId, LAYER_ID.strokes, ...SOURCE_FALLBACK_IDS].filter((id): id is string => Boolean(id))
  for (const id of ids) {
    const layer = layers.find((item) => item.id === id)
    if (layer && layer.strokes.length > 0) return layer
  }
  throw new Error('중심선을 가져올 획 데이터가 있는 레이어가 없습니다. 네이버/Hanzi/AnimCJK 레이어를 먼저 수신하세요.')
}

type OutlineDetail = { char: string; font_outline: string[]; layers: LayerRecord[] }

function requireFontContours(detail: OutlineDetail): string[] {
  const contours = fontContoursOf(detail)
  if (contours.length === 0) throw new Error('궁서체 윤곽이 없어 획 윤곽을 만들 수 없습니다.')
  return contours
}

const STALE_MESSAGE = '궁서체 윤곽이 바뀌어 매핑이 어긋났을 수 있습니다. [매핑 갱신]을 먼저 실행하세요.'

// 획 모양(outline_path)은 그대로 두고, 현재 궁서체 윤곽 기준으로 font_contours와 지문을 다시 정한다.
function withCurrentMapping(stroke: StrokeRecord, contours: string[], hash: string, loops = contourLoopsOf(contours)): StrokeRecord {
  return { ...stroke, font_contours: contourIndicesOfOutline(stroke.outline_path, loops), font_hash: hash }
}

export function createOutlineMapping(db: DatabaseSync, deps: { getCharacter: (unicode: string) => OutlineDetail | null }) {
  const requireDetail = (unicode: string): OutlineDetail => {
    const detail = deps.getCharacter(unicode)
    if (!detail) throw new Error('등록되지 않은 글자입니다.')
    return detail
  }

  // 궁서체 윤곽을 길잡이 중심선으로 획마다 나누고 각 획이 놓인 궁서체 윤곽 인덱스를 기록한다.
  // 사람이 직접 매핑한 획(map_manual)은 획 수가 같을 때 그대로 보존한다.
  function generate(unicode: string, sourceLayerId?: string) {
    const detail = requireDetail(unicode)
    const contours = requireFontContours(detail)
    const guide = pickGuideLayer(detail.layers, sourceLayerId)
    const pieces = splitOutlinePieces(contours, guide.strokes.map((stroke) => stroke.median_points))
    if (!pieces) throw new Error('궁서체 윤곽을 획으로 나누지 못했습니다. 길잡이 레이어를 바꿔 보세요.')

    const hash = fontFingerprint(contours)
    const previous = detail.layers.find((layer) => layer.id === OUTLINE_LAYER_ID)?.strokes ?? []
    const keepManual = previous.length === pieces.length
    if (!keepManual && previous.some((stroke) => stroke.map_manual)) {
      throw new Error('수동 매핑하거나 나이프로 나눈 획이 있어 획 수가 달라진 상태에서는 다시 만들 수 없습니다. 레이어를 원본으로 초기화한 뒤 다시 실행하세요.')
    }
    const strokes = pieces.map((piece, index): StrokeRecord => {
      const kept = keepManual ? previous[index] : undefined
      // 수동 획의 윤곽 모양은 그대로 두고, 궁서체 윤곽이 바뀌었으면 인덱스만 모양에서 다시 구한다.
      if (kept?.map_manual) return kept.font_hash === hash ? kept : withCurrentMapping(kept, contours, hash)
      const source = guide.strokes[index]
      return {
        stroke_order: index + 1,
        outline_path: piece.outline,
        median_points: piece.median,
        stroke_width: piece.width,
        is_radical: source?.is_radical ?? 0,
        start_cap_type: source?.start_cap_type ?? 'NONE',
        end_cap_type: source?.end_cap_type ?? 'NONE',
        font_contours: piece.contours,
        map_manual: 0,
        font_hash: hash,
      }
    })
    saveNonStrokeLayerContent(db, detail.char, OUTLINE_LAYER_ID, { strokes })
    patchLayersMeta(db, detail.char, [{ id: OUTLINE_LAYER_ID, visible: true }])
    return deps.getCharacter(unicode)
  }

  // 획 하나를 궁서체 윤곽(들)에 수작업으로 매핑한다. 빈 배열이면 매핑을 해제하고 중심선 띠 모양으로 되돌린다.
  function mapStroke(unicode: string, strokeIndex: number, contourIndicesRaw: unknown) {
    const detail = requireDetail(unicode)
    const contours = requireFontContours(detail)
    const layer = detail.layers.find((item) => item.id === OUTLINE_LAYER_ID)
    const target = layer?.strokes[strokeIndex]
    if (!layer || !target) throw new Error('매핑할 획이 없습니다. 먼저 [자동 매핑]으로 획 윤곽을 만드세요.')
    if (layer.stale) throw new Error(STALE_MESSAGE)
    if (!Array.isArray(contourIndicesRaw)) throw new Error('윤곽 인덱스 목록 형식이 올바르지 않습니다.')
    const indices = [...new Set(contourIndicesRaw.map(Number))].sort((a, b) => a - b)
    if (indices.some((i) => !Number.isInteger(i) || i < 0 || i >= contours.length)) {
      throw new Error('존재하지 않는 궁서체 윤곽입니다.')
    }
    const next: StrokeRecord = indices.length === 0
      ? {
        ...target,
        outline_path: ribbonPath(target.median_points, target.stroke_width || DEFAULT_STROKE_WIDTH),
        font_contours: [],
        map_manual: 0,
        font_hash: fontFingerprint(contours),
      }
      : { ...target, outline_path: indices.map((i) => contours[i]).join(' '), font_contours: indices, map_manual: 1, font_hash: fontFingerprint(contours) }
    const strokes = layer.strokes.map((stroke, index) => (index === strokeIndex ? next : stroke))
    saveNonStrokeLayerContent(db, detail.char, OUTLINE_LAYER_ID, { strokes })
    return deps.getCharacter(unicode)
  }

  // 궁서체 윤곽이 바뀐 뒤, 모든 획의 윤곽 인덱스를 획 모양에서 다시 구한다(획 모양은 바꾸지 않는다).
  function refresh(unicode: string) {
    const detail = requireDetail(unicode)
    const contours = requireFontContours(detail)
    const layer = detail.layers.find((item) => item.id === OUTLINE_LAYER_ID)
    if (!layer || layer.strokes.length === 0) throw new Error('갱신할 매핑이 없습니다. 먼저 [자동 매핑]으로 획 윤곽을 만드세요.')
    const hash = fontFingerprint(contours)
    const loops = contourLoopsOf(contours)
    const strokes = layer.strokes.map((stroke) => withCurrentMapping(stroke, contours, hash, loops))
    saveNonStrokeLayerContent(db, detail.char, OUTLINE_LAYER_ID, { strokes })
    return deps.getCharacter(unicode)
  }

  return { generate, mapStroke, refresh }
}
