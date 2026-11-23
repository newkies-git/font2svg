import type { DatabaseSync } from 'node:sqlite'
import { DEFAULT_STROKE_WIDTH, LAYER_ID } from '../shared/constants.ts'
import { isReferenceKind } from '../shared/layerKind.ts'
import type { FitStatus, WriteMode } from '../shared/types.ts'
import type { createCharacterCatalog } from './characterCatalog.ts'
import { transaction } from './db.ts'
import { fitGuideToFont, splitByContours } from './geometry.ts'
import type { createIssues } from './issues.ts'
import { parseResegmentMedians } from './layerRequests.ts'
import { fontContoursOf } from './layers.ts'
import { orderedReferenceLayer } from './referenceLayers.ts'
import { ACTOR_USER, ORIGIN_MANUAL, requireFound, type StrokeItem } from './model.ts'
import { splitFontByOllamaGuide, type OllamaSplitSource } from './ollamaSplit.ts'
import type { createReferencePipeline } from './referencePipeline.ts'
import { toItems, type StrokeStore } from './strokeStore.ts'

type CharacterLookup = ReturnType<typeof createCharacterCatalog>['getCharacter']

// 레이어(참고·궁서체)를 작업 획에 적용하는 흐름: 그대로·궁서체에 맞춤·재분할·Ollama 분리.
export function createLayerApply(
  db: DatabaseSync,
  deps: {
    strokes: StrokeStore
    issues: ReturnType<typeof createIssues>
    references: ReturnType<typeof createReferencePipeline>
    getCharacter: CharacterLookup
    fetchLayer: (unicode: string, layerId: string) => Promise<ReturnType<CharacterLookup>>
  },
) {
  const { strokes, issues, references, getCharacter, fetchLayer } = deps

  function updateStrokes(unicode: string, items: StrokeItem[], action: string) {
    strokes.updateStrokes(unicode, items, action)
    return getCharacter(unicode)
  }

  async function splitFontWithOllama(
    unicode: string,
    options: { source: OllamaSplitSource; model?: string; write?: WriteMode },
  ) {
    let detail = requireFound(getCharacter(unicode))
    const contours = fontContoursOf(detail)
    if (contours.length === 0) throw new Error('현재 글자에 궁서체 윤곽이 없습니다.')

    const targetLayerId = options.source === 'MMH' ? LAYER_ID.mmh : LAYER_ID.naver
    let guideLayer = detail.layers.find((item) => item.id === targetLayerId)
    if (!guideLayer || guideLayer.strokes.length === 0) {
      detail = requireFound(await fetchLayer(unicode, targetLayerId))
      guideLayer = detail.layers.find((item) => item.id === targetLayerId)
    }
    if (!guideLayer || guideLayer.strokes.length === 0) {
      throw new Error(`${options.source === 'MMH' ? 'Hanzi(MMH)' : '네이버'} 기준 획순 데이터를 가져올 수 없습니다.`)
    }

    const fitted = await splitFontByOllamaGuide({
      char: detail.char,
      source: options.source,
      contours,
      guideStrokes: guideLayer.strokes,
      model: options.model,
    })

    const radicals = guideLayer.strokes.flatMap((stroke, index) => (stroke.is_radical ? [index] : []))
    const items = toItems(fitted, new Set(radicals))
    const action = options.source === 'MMH' ? 'Ollama 궁서체 분리 (Hanzi)' : 'Ollama 궁서체 분리 (네이버)'
    const fitStatus = fitted.unmatched.length > 0 ? 'partial' : 'fitted'

    const kept = strokes.appendStrokes(unicode, options.write ?? 'replace', items, action, detail.strokes)
    if (kept !== null) {
      const next = getCharacter(unicode)
      return next && {
        ...next,
        fit_status: fitStatus,
        unmatched_strokes: fitted.unmatched.map((order) => order + kept),
        source: options.source,
        model: fitted.model,
      }
    }

    // 참고 획순(NAVER·MMH)으로 궁서체를 나눈 결과는 applyNaver·applyLayerToStrokes와 같게 strokes에 반영하되,
    // 사람이 요청한 AI 분리이므로 last_modified_by는 ACTOR_USER로 남겨 일괄 배치 덮어쓰기를 막고 이력을 보존한다.
    transaction(db, () => {
      strokes.replaceStrokes(
        unicode,
        items,
        ACTOR_USER,
        action,
        { source: options.source, url: guideLayer.source_url },
        fitted.fontOutline,
      )
      issues.clearIssue(unicode)
    })
    const next = getCharacter(unicode)
    return next && {
      ...next,
      fit_status: fitStatus,
      unmatched_strokes: fitted.unmatched,
      source: options.source,
      model: fitted.model,
    }
  }

  type AppliedDetail = NonNullable<ReturnType<CharacterLookup>> & {
    fit_status?: FitStatus
    unmatched_strokes?: number[]
  }

  function applyLayerToStrokes(
    unicode: string,
    layerId: string,
    mode: 'direct' | 'fit_font' = 'direct',
    write: WriteMode = 'replace',
  ): AppliedDetail | null {
    const detail = requireFound(getCharacter(unicode))
    const picked = detail.layers.find((item) => item.id === layerId)
    if (!picked || picked.strokes.length === 0) throw new Error('적용할 획 데이터가 없는 레이어입니다.')
    // 참고 레이어(네이버·Hanzi)는 획순은 네이버, 모양은 Hanzi로 합쳐 적용한다. 합칠 수 없으면 고른 레이어를 그대로 쓴다.
    const layer = isReferenceKind(picked.kind) ? (orderedReferenceLayer(detail.layers) ?? picked) : picked
    const source = isReferenceKind(layer.kind) ? layer.kind : ORIGIN_MANUAL
    const radicals = layer.strokes.flatMap((stroke, index) => (stroke.is_radical ? [index] : []))
    const kept = detail.strokes.length

    // 작업 획이 이미 있으면 추가만 이어 붙인다. 비어 있으면 교체와 같다.
    const commit = (items: StrokeItem[], action: string, glyph: Parameters<typeof references.saveImported>[4] | null) => {
      if (strokes.appendStrokes(unicode, write, items, action, detail.strokes) !== null) return getCharacter(unicode)
      if (glyph) {
        references.saveImported(unicode, source, layer.source_url, radicals, glyph, action)
        return getCharacter(unicode)
      }
      return updateStrokes(unicode, items, action)
    }

    // 참고 획은 궁서체(기본 레이어)에 맞춘다. 맞지 않는 획은 지우지 않고 번호로 돌려 작업 획에서 고치게 한다.
    const guide = layer.strokes.map((stroke) => stroke.median_points)
    const attachFit = (saved: ReturnType<typeof commit>, status: FitStatus, unmatched: number[]): AppliedDetail | null => {
      if (!saved || !isReferenceKind(layer.kind)) return saved
      const offset = write === 'append' && kept > 0 ? kept : 0
      return { ...saved, fit_status: status, unmatched_strokes: unmatched.map((order) => order + offset) }
    }

    const contours = fontContoursOf(detail)
    if (mode === 'fit_font' || isReferenceKind(layer.kind)) {
      if (contours.length === 0) {
        if (mode === 'fit_font') throw new Error('궁서체 윤곽이 없어 자동 분할을 적용할 수 없습니다.')
      } else {
        const fitted = fitGuideToFont(contours, guide, layer.strokes.map((stroke) => stroke.outline_path))
        if (fitted) {
          const glyph = { medians: fitted.medians, outlines: fitted.outlines, widths: fitted.widths, fontOutline: fitted.fontOutline }
          const saved = commit(toItems(glyph, new Set(radicals)), `${layer.name} 획을 궁서체에 맞춤`, glyph)
          return attachFit(saved, fitted.unmatched.length > 0 ? 'partial' : 'fitted', fitted.unmatched)
        }
        if (mode === 'fit_font') {
          throw new Error('궁서체 윤곽 자동 분할 품질 검사를 통과하지 못했습니다. 중심선·위치를 조정하거나 [그대로 적용]을 사용하세요.')
        }
      }
    }

    const glyph = {
      medians: layer.strokes.map((s) => s.median_points),
      outlines: layer.strokes.map((s) => s.outline_path),
      widths: layer.strokes.map((s) => s.stroke_width),
    }
    if (source !== ORIGIN_MANUAL) {
      const saved = commit(toItems(glyph, new Set(radicals)), `${layer.name} 레이어 적용`, glyph)
      const orders = layer.strokes.map((_, index) => index + 1)
      return attachFit(saved, contours.length > 0 ? 'copied' : 'no-font', orders)
    }
    return commit(layer.strokes, `${layer.name} 레이어 적용`, null)
  }

  function resegmentLayer(unicode: string, mediansRaw: unknown) {
    const detail = requireFound(getCharacter(unicode))
    const contours = fontContoursOf(detail)
    if (contours.length === 0) throw new Error('궁서체 윤곽이 없어 재분할할 수 없습니다.')
    const medians = parseResegmentMedians(mediansRaw)
    const split = splitByContours(contours, medians)
    if (!split) {
      throw new Error('중심선 기준 윤곽 자동 분할이 품질 검사를 통과하지 못했습니다. 중심선이 윤곽을 고르게 지나도록 조정해 보세요.')
    }
    return {
      outlines: split.outlines,
      medians: split.medians,
      widths: split.widths ?? split.medians.map(() => DEFAULT_STROKE_WIDTH),
    }
  }

  return { applyLayerToStrokes, resegmentLayer, splitFontWithOllama }
}
