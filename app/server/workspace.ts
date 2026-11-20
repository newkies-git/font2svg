import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_BUSY_TIMEOUT_MS, DEFAULT_STROKE_WIDTH, LAYER_ID } from '../shared/constants.ts'
import type { FitStatus, LayerMetaPatch } from '../shared/types.ts'
import { createCharacterCatalog } from './characterCatalog.ts'
import { isReferenceKind } from '../shared/layerKind.ts'
import { createCompileOutput } from './compileOutput.ts'
import { transaction } from './db.ts'
import { createFontApply } from './fontApply.ts'
import { fitGuideToFont, splitByContours } from './geometry.ts'
import { createIssues } from './issues.ts'
import { listOllamaStatus } from './ids.ts'
import { createOllamaIdsPipeline } from './ollamaIds.ts'
import { splitFontByOllamaGuide, type OllamaSplitSource } from './ollamaSplit.ts'
import { parseLayerBatch, parseResegmentMedians, type LayerSavePayload } from './layerRequests.ts'
import { fontContoursOf } from './layers.ts'
import {
  assertLayerUnlocked,
  createCustomLayer,
  deleteCustomLayer,
  patchLayersMeta,
  resetNonStrokeLayer,
  saveNonStrokeLayerContent,
} from './layerWrites.ts'
import { sanitizeLayerStrokes } from './layerData.ts'
import { toItems } from './strokeStore.ts'
import { ORIGIN_MANUAL, requireFound, type StrokeItem } from './model.ts'
import { createOutlineMapping } from './outlineMapping.ts'
import { createReferencePipeline } from './referencePipeline.ts'
import {
  ACJK_BLOB,
  fetchHanja,
  fetchNaver,
  hanjaUrl,
  naverUrl,
} from './references.ts'
import { migrate, seed } from './schema.ts'
import { createConversions } from './conversions.ts'
import { createStrokeStore } from './strokeStore.ts'

export type Workspace = ReturnType<typeof createWorkspace>

let singleton: { rootDir: string; workspace: Workspace } | null = null

// 개발 서버가 쓰는 프로세스 전역 작업 공간. 다른 폴더로 다시 부르면 조용히 첫 작업 공간을 주는 대신 던진다.
export function getWorkspace(rootDir: string): Workspace {
  if (!singleton) singleton = { rootDir, workspace: createWorkspace(rootDir) }
  if (singleton.rootDir !== rootDir) throw new Error(`작업 공간이 이미 ${singleton.rootDir}에서 열려 있습니다(요청: ${rootDir}).`)
  return singleton.workspace
}

// 독립된 작업 공간(DB 연결 포함)을 연다. 테스트는 이것으로 파일마다 자기 작업 공간을 쓰고 close()로 닫는다.
export function createWorkspace(rootDir: string) {
  const dbPath = path.join(rootDir, 'database', 'chusa1817.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const compiledDir = path.join(rootDir, 'output', 'compiled')
  fs.mkdirSync(compiledDir, { recursive: true })

  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`PRAGMA busy_timeout = ${DB_BUSY_TIMEOUT_MS}`)
  migrate(db, { backupBasePath: dbPath })
  seed(db)

  const strokes = createStrokeStore(db)
  const issues = createIssues(db)
  const font = createFontApply(db, rootDir, {
    strokes,
    getCharacter: (unicode) => catalog.getCharacter(unicode),
  })
  const catalog = createCharacterCatalog(db, {
    strokes,
    fontContours: (char) => font.getFont()?.contours(char) ?? null,
  })
  const references = createReferencePipeline(db, rootDir, {
    strokes,
    issues,
    fontOrGiven: font.fontOrGiven,
    fitOrGiven: font.fitOrGiven,
  })
  const ollamaIds = createOllamaIdsPipeline(db, rootDir, {
    strokes,
    issues,
    fitOrGiven: font.fitOrGiven,
  })
  const conversions = createConversions(db, { strokes, issues })
  const output = createCompileOutput(db, compiledDir, {
    getCharacter: catalog.getCharacter,
    setIssue: issues.setIssue,
    clearIssue: issues.clearIssue,
  })

  function getCharacter(unicode: string) {
    return catalog.getCharacter(unicode)
  }

  function updateStrokes(unicode: string, items: StrokeItem[], action: string) {
    strokes.updateStrokes(unicode, items, action)
    return getCharacter(unicode)
  }

  function importSvg(unicode: string, svg: string) {
    strokes.importSvg(unicode, svg)
    return getCharacter(unicode)
  }

  // 래스터 이미지에서 뽑은 윤곽을 획 SVG로 바꿔 저장하고 변환 이력을 남긴다.
  function importImage(unicode: string, raw: unknown) {
    conversions.importImage(unicode, raw)
    return getCharacter(unicode)
  }

  function approve(unicode: string) {
    strokes.approve(unicode)
    return getCharacter(unicode)
  }

  function undo(unicode: string) {
    strokes.undo(unicode)
    return getCharacter(unicode)
  }

  async function applyNaver(unicode: string, write: 'replace' | 'append' = 'replace') {
    const fit = await references.applyNaver(unicode, write)
    const detail = getCharacter(unicode)
    return detail && { ...detail, fit_status: fit.status, unmatched_strokes: fit.unmatched }
  }

  async function applyOllamaIds(
    unicode: string,
    options: { model?: string; ids?: string; write?: 'replace' | 'append' } = {},
  ) {
    const fit = await ollamaIds.applyIds(unicode, options)
    const detail = getCharacter(unicode)
    return detail && {
      ...detail,
      fit_status: fit.status,
      unmatched_strokes: fit.unmatched,
      ids: fit.ids,
      model: fit.model,
    }
  }

  async function splitFontWithOllama(
    unicode: string,
    options: { source: OllamaSplitSource; model?: string; write?: 'replace' | 'append' },
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
    const existing = detail.strokes
    const fitStatus = fitted.unmatched.length > 0 ? 'partial' : 'fitted'

    if (options.write === 'append' && existing.length > 0) {
      updateStrokes(unicode, [...existing, ...items], `${action} 추가`)
      const next = getCharacter(unicode)
      return next && {
        ...next,
        fit_status: fitStatus,
        unmatched_strokes: fitted.unmatched.map((order) => order + existing.length),
        source: options.source,
        model: fitted.model,
      }
    }

    references.saveImported(unicode, options.source, guideLayer.source_url, radicals, fitted, action)
    const next = getCharacter(unicode)
    return next && {
      ...next,
      fit_status: fitStatus,
      unmatched_strokes: fitted.unmatched,
      source: options.source,
      model: fitted.model,
    }
  }

  function updateLayersMeta(unicode: string, patches: LayerMetaPatch[]) {
    const character = strokes.requireCharacter(unicode)
    patchLayersMeta(db, character.char, Array.isArray(patches) ? patches : [])
    return getCharacter(unicode)
  }

  // 레이어 하나를 저장한다(응답은 만들지 않는다). 작업 획 레이어는 이력이 남는 획 저장을 쓴다.
  function writeLayer(unicode: string, char: string, layerId: string, payload: LayerSavePayload) {
    if (layerId === LAYER_ID.mmh || layerId === LAYER_ID.acjk || layerId === LAYER_ID.naver) {
      throw new Error('참고 레이어(네이버·AnimCJK·Hanzi)는 편집하지 않습니다. 작업 획으로 가져온 뒤 고치세요.')
    }
    assertLayerUnlocked(db, char, layerId)
    if (layerId === LAYER_ID.strokes) {
      strokes.updateStrokes(unicode, sanitizeLayerStrokes(payload.strokes), payload.action ?? '획 편집')
      return
    }
    saveNonStrokeLayerContent(db, char, layerId, payload)
  }

  function saveLayer(unicode: string, layerId: string, payload: LayerSavePayload) {
    const character = strokes.requireCharacter(unicode)
    writeLayer(unicode, String(character.char), layerId, payload)
    return getCharacter(unicode)
  }

  // 여러 레이어를 한 트랜잭션으로 저장한다. 하나라도 실패하면 전부 되돌려 일부만 저장되지 않는다.
  function saveLayers(unicode: string, items: unknown) {
    const character = strokes.requireCharacter(unicode)
    const batch = parseLayerBatch(items)
    transaction(db, () => {
      for (const { id, payload } of batch) writeLayer(unicode, String(character.char), id, payload)
    })
    return getCharacter(unicode)
  }

  function resetLayer(unicode: string, layerId: string) {
    const character = strokes.requireCharacter(unicode)
    resetNonStrokeLayer(db, character.char, layerId)
    return getCharacter(unicode)
  }

  // 외부 수신을 지원하는 레이어별 수신 방법. retryMiss는 "없음"으로 저장된 이전 결과를 지우고 다시 받는다(네이버는 사전이 갱신될 수 있다).
  const remoteLayers: Record<string, { retryMiss?: boolean; notFound: string; load: (unicode: string, char: string) => Promise<unknown> }> = {
    [LAYER_ID.naver]: {
      retryMiss: true,
      notFound: '네이버 한자사전에서 이 글자의 획순을 찾지 못했습니다.',
      load: (unicode, char) => references.loadSource(unicode, 'NAVER', naverUrl(char), () => fetchNaver(char)),
    },
    [LAYER_ID.acjk]: {
      notFound: 'AnimCJK에서 이 글자 데이터를 찾지 못했습니다.',
      load: (unicode, char) => references.loadSource(unicode, 'ACJK', ACJK_BLOB, () => references.fetchAcjk(char)),
    },
    [LAYER_ID.mmh]: {
      notFound: 'Hanzi(MMH)에서 이 글자 데이터를 찾지 못했습니다.',
      load: (unicode, char) => references.loadSource(unicode, 'MMH', hanjaUrl(char), () => fetchHanja(char)),
    },
  }

  async function fetchLayer(unicode: string, layerId: string) {
    const character = strokes.requireCharacter(unicode)
    const remote = Object.hasOwn(remoteLayers, layerId) ? remoteLayers[layerId] : undefined
    if (!remote) throw new Error('외부 수신을 지원하지 않는 레이어입니다.')
    if (remote.retryMiss) db.prepare(`DELETE FROM reference_data WHERE unicode = ? AND source = 'NAVER' AND found = 0`).run(unicode)
    if (!(await remote.load(unicode, character.char))) throw new Error(remote.notFound)
    patchLayersMeta(db, character.char, [{ id: layerId, visible: true }])
    return getCharacter(unicode)
  }

  type AppliedDetail = NonNullable<ReturnType<typeof catalog.getCharacter>> & {
    fit_status?: FitStatus
    unmatched_strokes?: number[]
  }

  function applyLayerToStrokes(
    unicode: string,
    layerId: string,
    mode: 'direct' | 'fit_font' = 'direct',
    write: 'replace' | 'append' = 'replace',
  ): AppliedDetail | null {
    const detail = requireFound(getCharacter(unicode))
    const layer = detail.layers.find((item) => item.id === layerId)
    if (!layer || layer.strokes.length === 0) throw new Error('적용할 획 데이터가 없는 레이어입니다.')
    const source = isReferenceKind(layer.kind) ? layer.kind : ORIGIN_MANUAL
    const radicals = layer.strokes.flatMap((stroke, index) => (stroke.is_radical ? [index] : []))
    const kept = detail.strokes.length

    // 작업 획이 이미 있으면 추가만 이어 붙인다. 비어 있으면 교체와 같다.
    const commit = (items: StrokeItem[], action: string, glyph: Parameters<typeof references.saveImported>[4] | null) => {
      if (write === 'append' && detail.strokes.length > 0) {
        return updateStrokes(unicode, [...detail.strokes, ...items], `${action} 추가`)
      }
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

    if (mode === 'fit_font' || isReferenceKind(layer.kind)) {
      const contours = fontContoursOf(detail)
      if (contours.length === 0) {
        if (mode === 'fit_font') throw new Error('궁서체 윤곽이 없어 자동 분할을 적용할 수 없습니다.')
      } else {
        const fitted = fitGuideToFont(contours, guide)
        if (!fitted) {
          if (mode === 'fit_font' && !isReferenceKind(layer.kind)) {
            throw new Error('궁서체 윤곽 자동 분할 품질 검사를 통과하지 못했습니다. 중심선·위치를 조정하거나 [그대로 적용]을 사용하세요.')
          }
        } else {
          const glyph = { medians: fitted.medians, outlines: fitted.outlines, widths: fitted.widths, fontOutline: fitted.fontOutline }
          const saved = commit(toItems(glyph, new Set(radicals)), `${layer.name} 획을 궁서체에 맞춤`, isReferenceKind(layer.kind) || mode === 'fit_font' ? glyph : null)
          return attachFit(saved, fitted.unmatched.length > 0 ? 'partial' : 'fitted', fitted.unmatched)
        }
      }
      if (mode === 'fit_font') {
        const split = splitByContours(fontContoursOf(detail), guide)
        if (!split) {
          throw new Error('궁서체 윤곽 자동 분할 품질 검사를 통과하지 못했습니다. 중심선·위치를 조정하거나 [그대로 적용]을 사용하세요.')
        }
        return commit(toItems(split, new Set(radicals)), `${layer.name} 중심선으로 궁서체 분할 적용`, split)
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
      return attachFit(saved, fontContoursOf(detail).length > 0 ? 'copied' : 'no-font', orders)
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

  function duplicateLayer(unicode: string, sourceLayerId?: string, name?: string) {
    const detail = requireFound(getCharacter(unicode))
    const createdId = createCustomLayer(db, detail.char, detail.layers, sourceLayerId, name)
    return { createdId, detail: getCharacter(unicode) }
  }

  const outline = createOutlineMapping(db, { getCharacter })

  function deleteLayer(unicode: string, layerId: string) {
    const character = strokes.requireCharacter(unicode)
    deleteCustomLayer(db, character.char, layerId)
    return getCharacter(unicode)
  }

  return {
    close: () => db.close(),
    listCharacters: catalog.listCharacters,
    getCharacter,
    updateStrokes,
    updateLayersMeta,
    saveLayer,
    saveLayers,
    resetLayer,
    fetchLayer,
    applyLayerToStrokes,
    resegmentLayer,
    generateOutline: outline.generate,
    mapOutlineStroke: outline.mapStroke,
    refreshOutline: outline.refresh,
    duplicateLayer,
    deleteLayer,
    importSvg,
    importImage,
    listConversions: conversions.listConversions,
    approve,
    undo,
    applyNaver,
    getOllamaStatus: listOllamaStatus,
    inferOllamaIds: ollamaIds.inferIds,
    applyOllamaIds,
    splitFontWithOllama,
    applyFontBatch: font.applyFontBatch,
    applyAcjkBatch: references.applyAcjkBatch,
    compile: output.compile,
    listRadicals: catalog.listRadicals,
    importInitial: catalog.importInitial,
  }
}
