import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DB_BUSY_TIMEOUT_MS, LAYER_ID } from '../shared/constants.ts'
import type { LayerMetaPatch, WriteMode } from '../shared/types.ts'
import { createCharacterCatalog } from './characterCatalog.ts'
import { createCompileOutput } from './compileOutput.ts'
import { transaction } from './db.ts'
import { createFontApply } from './fontApply.ts'
import { createIssues } from './issues.ts'
import { createLayerApply } from './layerApply.ts'
import { createLayerFetch } from './layerFetch.ts'
import { listOllamaStatus } from './ids.ts'
import { createOllamaIdsPipeline } from './ollamaIds.ts'
import { parseLayerBatch, type LayerSavePayload } from './layerRequests.ts'
import {
  assertLayerUnlocked,
  createCustomLayer,
  deleteCustomLayer,
  patchLayersMeta,
  resetNonStrokeLayer,
  saveNonStrokeLayerContent,
} from './layerWrites.ts'
import { sanitizeLayerStrokes } from './layerData.ts'
import { ACTION_CHAT_EDIT, ACTOR_USER, requireFound } from './model.ts'
import { applyStrokeEdits, sanitizeEdits, strokesFingerprint } from './strokeEdits.ts'
import { createOutlineMapping } from './outlineMapping.ts'
import { createReferencePipeline } from './referencePipeline.ts'
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
  const references = createReferencePipeline(db, {
    strokes,
    issues,
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

  // 글자 하나를 바꾸는 작업을 감싸 바뀐 뒤의 글자 상세를 돌려준다.
  const withDetail = <Args extends unknown[]>(change: (unicode: string, ...args: Args) => unknown) =>
    (unicode: string, ...args: Args) => {
      change(unicode, ...args)
      return getCharacter(unicode)
    }

  const updateStrokes = withDetail(strokes.updateStrokes)
  const importSvg = withDetail(strokes.importSvg)
  // 래스터 이미지에서 뽑은 윤곽을 획 SVG로 바꿔 저장하고 변환 이력을 남긴다.
  const importImage = withDetail(conversions.importImage)
  const approve = withDetail(strokes.approve)
  const undo = withDetail(strokes.undo)

  const layerFetch = createLayerFetch(db, { strokes, references, getCharacter })
  const layerApply = createLayerApply(db, { strokes, issues, references, getCharacter, fetchLayer: layerFetch.fetchLayer })

  async function applyNaver(unicode: string, write: WriteMode = 'replace') {
    const fit = await references.applyNaver(unicode, write)
    const detail = getCharacter(unicode)
    return detail && { ...detail, fit_status: fit.status, unmatched_strokes: fit.unmatched }
  }

  async function applyOllamaIds(
    unicode: string,
    options: { model?: string; ids?: string; write?: WriteMode } = {},
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

  // 채팅 모델이 제안하고 사용자가 승인한 획 수정을 작업 획에 반영한다. 이력이 남아 실행 취소할 수 있다.
  function applyChatEdits(unicode: string, rawEdits: unknown, fingerprint: unknown, confirmWorking: unknown) {
    const character = strokes.requireCharacter(unicode)
    const detail = requireFound(getCharacter(unicode))
    if (fingerprint !== strokesFingerprint(detail.strokes)) throw new Error('제안을 받은 뒤 획 데이터가 바뀌어 적용하지 않았습니다. 다시 요청하세요.')
    const edits = sanitizeEdits(rawEdits, detail.strokes.length)
    if (edits.length === 0) throw new Error('적용할 수 있는 수정이 없습니다. 획 번호가 바뀌었는지 확인하세요.')
    assertLayerUnlocked(db, character.char, LAYER_ID.strokes)
    // 승인 전 글자는 작업 데이터를 바로 덮어써 화면에서 되돌릴 수 없으므로, 사용자가 그 사실을 확인했을 때만 적용한다.
    if (detail.working && confirmWorking !== true) throw new Error('승인 전 글자는 작업 데이터를 덮어써 되돌릴 수 없습니다. 확인 후 다시 적용하세요.')
    const next = applyStrokeEdits(detail.strokes, edits)
    transaction(db, () => {
      if (detail.working) strokes.archiveWorking(unicode, ACTION_CHAT_EDIT, ACTOR_USER)
      strokes.updateStrokes(unicode, sanitizeLayerStrokes(next), `${ACTION_CHAT_EDIT} (${edits.length}건)`)
    })
    return getCharacter(unicode)
  }

  function updateLayersMeta(unicode: string, patches: LayerMetaPatch[]) {
    const character = strokes.requireCharacter(unicode)
    patchLayersMeta(db, character.char, Array.isArray(patches) ? patches : [])
    return getCharacter(unicode)
  }

  // 레이어 하나를 저장한다(응답은 만들지 않는다). 작업 획 레이어는 이력이 남는 획 저장을 쓴다.
  function writeLayer(unicode: string, char: string, layerId: string, payload: LayerSavePayload) {
    if (layerId === LAYER_ID.mmh || layerId === LAYER_ID.naver) {
      throw new Error('참고 레이어(네이버·Hanzi)는 편집하지 않습니다. 작업 획으로 가져온 뒤 고치세요.')
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
    fetchLayer: layerFetch.fetchLayer,
    applyLayerToStrokes: layerApply.applyLayerToStrokes,
    resegmentLayer: layerApply.resegmentLayer,
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
    splitFontWithOllama: layerApply.splitFontWithOllama,
    applyChatEdits,
    applyFontBatch: font.applyFontBatch,
    prefetchReferences: references.prefetchReferences,
    syncStrokeCountsFromNaver: references.syncStrokeCountsFromNaver,
    compile: output.compile,
    listRadicals: catalog.listRadicals,
    importInitial: catalog.importInitial,
  }
}
