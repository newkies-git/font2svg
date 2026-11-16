import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_STROKE_WIDTH, LAYER_ID } from '../src/lib/constants.ts'
import type { LayerRecord, StrokeRecord } from '../src/types.ts'
import { ribbonPath, splitOutlinePieces } from './geometry.ts'
import { fontContoursOf, patchLayersMeta, saveNonStrokeLayerContent } from './layers.ts'

export const OUTLINE_LAYER_ID = LAYER_ID.outline
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

    const previous = detail.layers.find((layer) => layer.id === OUTLINE_LAYER_ID)?.strokes ?? []
    const keepManual = previous.length === pieces.length
    if (!keepManual && previous.some((stroke) => stroke.map_manual)) {
      throw new Error('수동 매핑하거나 나이프로 나눈 획이 있어 획 수가 달라진 상태에서는 다시 만들 수 없습니다. 레이어를 원본으로 초기화한 뒤 다시 실행하세요.')
    }
    const strokes = pieces.map((piece, index): StrokeRecord => {
      const kept = keepManual ? previous[index] : undefined
      if (kept?.map_manual) return kept
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
      }
      : { ...target, outline_path: indices.map((i) => contours[i]).join(' '), font_contours: indices, map_manual: 1 }
    const strokes = layer.strokes.map((stroke, index) => (index === strokeIndex ? next : stroke))
    saveNonStrokeLayerContent(db, detail.char, OUTLINE_LAYER_ID, { strokes })
    return deps.getCharacter(unicode)
  }

  return { generate, mapStroke }
}
