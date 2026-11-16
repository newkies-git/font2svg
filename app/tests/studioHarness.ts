import { mock } from 'node:test'
import { useLayerWorkspace } from '../src/composables/useLayerWorkspace.ts'
import { useStudioState } from '../src/composables/useStudioState.ts'
import { LAYER_ID } from '../shared/constants.ts'
import type { CharacterDetail, LayerRecord, StrokeRecord } from '../shared/types.ts'
import { rectPath, strokeOf } from './helpers.ts'

const UNICODE = 'U+4E00'
export const ENCODED_UNICODE = 'U%2B4E00'

export const bar = (y: number): StrokeRecord => strokeOf(rectPath(100, y, 500, y + 60), [[110, y + 30], [490, y + 30]])

export function layerOf(id: string, kind: LayerRecord['kind'], overrides: Partial<LayerRecord> = {}): LayerRecord {
  return { id, kind, name: id, z_index: 0, visible: true, opacity: 1, locked: false, label_color: 'none', available: true, modified: false, source_url: null, strokes: [], paths: [], ...overrides }
}

// 화면이 받는 글자 상세. 레이어마다 z_index를 순서대로 준다.
export function detailOf(layers: LayerRecord[], overrides: Partial<CharacterDetail> = {}): CharacterDetail {
  const ordered = layers.map((layer, index) => ({ ...layer, z_index: layer.z_index || index }))
  const work = ordered.find((layer) => layer.id === LAYER_ID.strokes)
  return {
    unicode: UNICODE, char: '一', grade: null, issue_reason: null, issue_status: null, in_font: 1, working: false, reading: '일', meaning: null,
    variant_reading: [], variant_meaning: [], stroke_count: work?.strokes.length ?? 0, radical: 1, font_outline: [], origin: 'MMH', origin_url: null,
    last_modified_at: '', last_modified_by: 'user', strokes: work?.strokes ?? [], layers: ordered, history_count: 0, ...overrides,
  }
}

type RecordedCall = { method: string; url: string; body: unknown }
type Handler = (call: RecordedCall) => { status?: number; body: unknown }

// 전역 fetch를 가짜로 바꾼다. 등록하지 않은 경로는 404, 호출은 모두 기록한다. 끝나면 restore()로 되돌린다.
export function fakeApi() {
  const calls: RecordedCall[] = []
  const routes: { method: string; pattern: RegExp; handler: Handler }[] = []
  const fetchMock = mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const call: RecordedCall = { method: init?.method ?? 'GET', url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(call)
    const route = routes.find((item) => item.method === call.method && item.pattern.test(call.url))
    const result = route ? route.handler(call) : { status: 404, body: { error: `no route: ${call.method} ${call.url}` } }
    return new Response(JSON.stringify(result.body), { status: result.status ?? 200 })
  })
  return {
    calls,
    on(method: string, pattern: RegExp, handler: Handler | unknown) {
      routes.push({ method, pattern, handler: typeof handler === 'function' ? handler as Handler : () => ({ body: handler }) })
    },
    urls: () => calls.map((call) => `${call.method} ${call.url.replace('/api/characters/' + ENCODED_UNICODE, '')}`),
    restore: () => fetchMock.mock.restore(),
  }
}

// 선택된 글자와 레이어가 들어 있는 작업 공간(useLayerWorkspace)을 조립한다.
export function setupWorkspace(layers: LayerRecord[], options: { activeLayerId?: string } = {}) {
  const studio = useStudioState()
  const detail = detailOf(layers)
  studio.selected.value = detail
  const reloaded = { count: 0 }
  const stopped = { count: 0 }
  const workspace = useLayerWorkspace(studio, {
    onReloadList: async () => { reloaded.count += 1 },
    stopPlayback: () => { stopped.count += 1 },
  })
  workspace.syncFromDetail(detail)
  if (options.activeLayerId) workspace.activeLayerId.value = options.activeLayerId
  return { studio, workspace, detail, reloaded, stopped }
}

// 화면에서 편집이 일어난 것처럼 레이어를 저장 대기(dirty)로 표시한다.
export function markDirty(workspace: ReturnType<typeof setupWorkspace>['workspace'], layerId: string) {
  workspace.dirtyIds.value = new Set([...workspace.dirtyIds.value, layerId])
}
