import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_BUSY_TIMEOUT_MS, DEFAULT_STROKE_WIDTH, LAYER_BATCH_LIMIT, LAYER_ID } from '../shared/constants.ts'
import type { LayerMetaPatch, Pt } from '../shared/types.ts'
import { createCharacterCatalog } from './characterCatalog.ts'
import { isReferenceKind } from '../shared/layerKind.ts'
import { createCompileOutput } from './compileOutput.ts'
import { transaction } from './db.ts'
import { createFontApply } from './fontApply.ts'
import { roundPoints, splitByContours } from './geometry.ts'
import { createIssues } from './issues.ts'
import {
  assertLayerUnlocked,
  createCustomLayer,
  deleteCustomLayer,
  fontContoursOf,
  patchLayersMeta,
  resetNonStrokeLayer,
  saveNonStrokeLayerContent,
} from './layers.ts'
import { sanitizeLayerStrokes } from './layerData.ts'
import { ORIGIN_MANUAL, type StrokeItem } from './model.ts'
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
import { createStrokeStore } from './strokeStore.ts'

export type Workspace = ReturnType<typeof createWorkspace>

let singleton: Workspace | null = null

export function getWorkspace(rootDir: string): Workspace {
  if (!singleton) singleton = createWorkspace(rootDir)
  return singleton
}

function createWorkspace(rootDir: string) {
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
    getFont: () => font.getFont(),
    fontOrGiven: font.fontOrGiven,
  })
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

  function approve(unicode: string) {
    strokes.approve(unicode)
    return getCharacter(unicode)
  }

  function undo(unicode: string) {
    strokes.undo(unicode)
    return getCharacter(unicode)
  }

  async function applyNaver(unicode: string) {
    await references.applyNaver(unicode)
    return getCharacter(unicode)
  }

  function updateLayersMeta(unicode: string, patches: LayerMetaPatch[]) {
    const character = strokes.requireCharacter(unicode)
    patchLayersMeta(db, character.char, Array.isArray(patches) ? patches : [])
    return getCharacter(unicode)
  }

  type LayerSavePayload = { strokes?: unknown; paths?: unknown; action?: string }

  // 레이어 하나를 저장한다(응답은 만들지 않는다). 작업 획 레이어는 이력이 남는 획 저장을 쓴다.
  function writeLayer(unicode: string, char: string, layerId: string, payload: LayerSavePayload) {
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
    if (!Array.isArray(items) || items.length === 0) throw new Error('저장할 레이어 목록이 비어 있습니다.')
    if (items.length > LAYER_BATCH_LIMIT) throw new Error(`한 번에 저장할 수 있는 레이어는 ${LAYER_BATCH_LIMIT}개까지입니다.`)
    const ids = new Set<string>()
    const batch = items.map((item, index) => {
      const entry = (item ?? {}) as { id?: unknown } & LayerSavePayload
      if (typeof entry.id !== 'string' || !entry.id) throw new Error(`${index + 1}번째 레이어에 id가 없습니다.`)
      if (ids.has(entry.id)) throw new Error(`레이어 '${entry.id}'가 중복되었습니다.`)
      ids.add(entry.id)
      return { id: entry.id, payload: { strokes: entry.strokes, paths: entry.paths, action: typeof entry.action === 'string' ? entry.action : undefined } }
    })
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

  async function fetchLayer(unicode: string, layerId: string) {
    const character = strokes.requireCharacter(unicode)
    if (layerId === LAYER_ID.naver) {
      db.prepare(`DELETE FROM reference_data WHERE unicode = ? AND source = 'NAVER' AND found = 0`).run(unicode)
      const naver = await references.loadSource(unicode, 'NAVER', naverUrl(character.char), () => fetchNaver(character.char))
      if (!naver) throw new Error('네이버 한자사전에서 이 글자의 획순을 찾지 못했습니다.')
    } else if (layerId === LAYER_ID.acjk) {
      const acjk = await references.loadSource(unicode, 'ACJK', ACJK_BLOB, () => references.fetchAcjk(character.char))
      if (!acjk) throw new Error('AnimCJK에서 이 글자 데이터를 찾지 못했습니다.')
    } else if (layerId === LAYER_ID.mmh) {
      const mmh = await references.loadSource(unicode, 'MMH', hanjaUrl(character.char), () => fetchHanja(character.char))
      if (!mmh) throw new Error('Hanzi(MMH)에서 이 글자 데이터를 찾지 못했습니다.')
    } else {
      throw new Error('외부 수신을 지원하지 않는 레이어입니다.')
    }
    patchLayersMeta(db, character.char, [{ id: layerId, visible: true }])
    return getCharacter(unicode)
  }

  function applyLayerToStrokes(unicode: string, layerId: string, mode: 'direct' | 'fit_font' = 'direct') {
    const detail = getCharacter(unicode)
    if (!detail) throw new Error('등록되지 않은 글자입니다.')
    const layer = detail.layers.find((item) => item.id === layerId)
    if (!layer || layer.strokes.length === 0) throw new Error('적용할 획 데이터가 없는 레이어입니다.')
    const source = isReferenceKind(layer.kind) ? layer.kind : ORIGIN_MANUAL
    const radicals = layer.strokes.flatMap((stroke, index) => (stroke.is_radical ? [index] : []))

    if (mode === 'fit_font') {
      const contours = fontContoursOf(detail)
      if (contours.length === 0) throw new Error('궁서체 윤곽이 없어 자동 분할을 적용할 수 없습니다.')
      const split = splitByContours(contours, layer.strokes.map((stroke) => stroke.median_points))
      if (!split) {
        throw new Error('궁서체 윤곽 자동 분할 품질 검사를 통과하지 못했습니다. 중심선·위치를 조정하거나 [그대로 적용]을 사용하세요.')
      }
      references.saveImported(unicode, source, layer.source_url, radicals, split, `${layer.name} 중심선으로 궁서체 분할 적용`)
      return getCharacter(unicode)
    }

    if (source !== ORIGIN_MANUAL) {
      references.saveImported(
        unicode,
        source,
        layer.source_url,
        radicals,
        {
          medians: layer.strokes.map((s) => s.median_points),
          outlines: layer.strokes.map((s) => s.outline_path),
          widths: layer.strokes.map((s) => s.stroke_width),
        },
        `${layer.name} 레이어 적용`,
      )
      return getCharacter(unicode)
    }
    return updateStrokes(unicode, layer.strokes, `${layer.name} 레이어 적용`)
  }

  function resegmentLayer(unicode: string, mediansRaw: unknown) {
    const detail = getCharacter(unicode)
    if (!detail) throw new Error('등록되지 않은 글자입니다.')
    const contours = fontContoursOf(detail)
    if (contours.length === 0) throw new Error('궁서체 윤곽이 없어 재분할할 수 없습니다.')
    if (!Array.isArray(mediansRaw) || mediansRaw.length === 0) throw new Error('중심선 배열이 비어 있습니다.')
    const medians = mediansRaw.map((line, index) => {
      if (!Array.isArray(line) || line.length < 2) throw new Error(`${index + 1}획 중심선은 2점 이상이어야 합니다.`)
      return roundPoints(line as Pt[])
    })
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
    const detail = getCharacter(unicode)
    if (!detail) throw new Error('등록되지 않은 글자입니다.')
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
    approve,
    undo,
    applyNaver,
    ensureReference: references.ensureReference,
    syncMissing: references.syncMissing,
    applyFontBatch: font.applyFontBatch,
    applyAcjkBatch: references.applyAcjkBatch,
    compile: output.compile,
    listRadicals: catalog.listRadicals,
    importInitial: catalog.importInitial,
  }
}
