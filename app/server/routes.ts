import { ACJK_BATCH_LIMIT, FONT_BATCH_LIMIT, MISSING_FETCH_LIMIT } from '../src/lib/constants.ts'
import type { LayerMetaPatch } from '../src/types.ts'
import type { StrokeItem } from './model.ts'
import type { Workspace } from './workspace.ts'

export const HTTP_OK = 200
export const HTTP_BAD_REQUEST = 400
export const HTTP_FORBIDDEN = 403
export const HTTP_NOT_FOUND = 404

export type ApiResult = { status: number; body: unknown }

export type ApiRequest = {
  method: string
  // 예: /api/characters/U%2B4E01/approve
  pathname: string
  searchParams: URLSearchParams
  // 요청 본문(JSON 객체). 본문이 없으면 {}.
  readBody: () => Promise<Record<string, unknown>>
}

type RouteContext = {
  ws: Workspace
  // 경로의 :이름 구간 값(URL 디코딩됨)
  params: Record<string, string>
  searchParams: URLSearchParams
  body: () => Promise<Record<string, unknown>>
}

type Route = {
  method: string
  // '/' 로 구분한 구간. ':이름'은 값을 받는 구간이고, 이름이 unicode면 U+로 시작해야 한다.
  pattern: string
  handler: (context: RouteContext) => unknown | Promise<unknown>
}

const NOT_FOUND_API = '없는 API입니다.'
const NOT_FOUND_CHARACTER = '없는 글자입니다.'
const UNICODE_PREFIX = 'U+'

function limitOf(value: unknown, fallback: number): number {
  const limit = Number(value ?? fallback)
  return Number.isFinite(limit) ? limit : fallback
}

const text = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)

const ROUTES: Route[] = [
  { method: 'GET', pattern: 'characters', handler: ({ ws, searchParams }) => ws.listCharacters(searchParams.get('q') ?? '') },
  { method: 'GET', pattern: 'radicals', handler: ({ ws }) => ws.listRadicals() },
  {
    method: 'POST',
    pattern: 'import',
    handler: async ({ ws, body }) => {
      const payload = await body()
      return ws.importInitial(Array.isArray(payload) ? payload : payload.entries)
    },
  },
  {
    method: 'POST',
    pattern: 'sync-missing',
    handler: async ({ ws, body }) => ws.syncMissing(limitOf((await body()).limit, MISSING_FETCH_LIMIT)),
  },
  {
    method: 'POST',
    pattern: 'apply-font',
    handler: async ({ ws, body }) => {
      const payload = await body()
      return ws.applyFontBatch(String(payload.after ?? ''), limitOf(payload.limit, FONT_BATCH_LIMIT))
    },
  },
  {
    method: 'POST',
    pattern: 'apply-acjk',
    handler: async ({ ws, body }) => {
      const payload = await body()
      return ws.applyAcjkBatch(String(payload.after ?? ''), limitOf(payload.limit, ACJK_BATCH_LIMIT))
    },
  },
  {
    method: 'GET',
    pattern: 'characters/:unicode',
    handler: ({ ws, params }) => ws.getCharacter(params.unicode) ?? new NotFound(NOT_FOUND_CHARACTER),
  },
  {
    method: 'POST',
    pattern: 'characters/:unicode/strokes',
    handler: async ({ ws, params, body }) => {
      const payload = await body()
      return ws.updateStrokes(params.unicode, payload.strokes as StrokeItem[], String(payload.action ?? '편집'))
    },
  },
  {
    method: 'POST',
    pattern: 'characters/:unicode/import-svg',
    handler: async ({ ws, params, body }) => ws.importSvg(params.unicode, String((await body()).svg ?? '')),
  },
  { method: 'POST', pattern: 'characters/:unicode/approve', handler: ({ ws, params }) => ws.approve(params.unicode) },
  { method: 'POST', pattern: 'characters/:unicode/undo', handler: ({ ws, params }) => ws.undo(params.unicode) },
  { method: 'POST', pattern: 'characters/:unicode/reference', handler: ({ ws, params }) => ws.ensureReference(params.unicode) },
  { method: 'POST', pattern: 'characters/:unicode/apply-naver', handler: ({ ws, params }) => ws.applyNaver(params.unicode) },
  { method: 'POST', pattern: 'characters/:unicode/compile', handler: ({ ws, params }) => ws.compile(params.unicode) },
  {
    method: 'POST',
    pattern: 'characters/:unicode/outline/generate',
    handler: async ({ ws, params, body }) => ws.generateOutline(params.unicode, text((await body()).sourceLayerId) || undefined),
  },
  {
    method: 'POST',
    pattern: 'characters/:unicode/outline/map',
    handler: async ({ ws, params, body }) => {
      const payload = await body()
      return ws.mapOutlineStroke(params.unicode, Number(payload.strokeIndex), payload.contours)
    },
  },
  { method: 'POST', pattern: 'characters/:unicode/outline/refresh', handler: ({ ws, params }) => ws.refreshOutline(params.unicode) },
  {
    method: 'POST',
    pattern: 'characters/:unicode/layers-meta',
    handler: async ({ ws, params, body }) => ws.updateLayersMeta(params.unicode, (await body()).patches as LayerMetaPatch[]),
  },
  {
    method: 'POST',
    pattern: 'characters/:unicode/resegment',
    handler: async ({ ws, params, body }) => ws.resegmentLayer(params.unicode, (await body()).medians),
  },
  {
    method: 'POST',
    pattern: 'characters/:unicode/layers',
    handler: async ({ ws, params, body }) => {
      const payload = await body()
      return ws.duplicateLayer(params.unicode, text(payload.sourceLayerId) || undefined, text(payload.name) || undefined)
    },
  },
  { method: 'DELETE', pattern: 'characters/:unicode/layers/:layerId', handler: ({ ws, params }) => ws.deleteLayer(params.unicode, params.layerId) },
  {
    method: 'POST',
    pattern: 'characters/:unicode/layers/:layerId/save',
    handler: async ({ ws, params, body }) => {
      const payload = await body()
      return ws.saveLayer(params.unicode, params.layerId, {
        strokes: payload.strokes,
        paths: payload.paths,
        action: typeof payload.action === 'string' ? payload.action : undefined,
      })
    },
  },
  { method: 'POST', pattern: 'characters/:unicode/layers/batch', handler: async ({ ws, params, body }) => ws.saveLayers(params.unicode, (await body()).layers) },
  { method: 'POST', pattern: 'characters/:unicode/layers/:layerId/reset', handler: ({ ws, params }) => ws.resetLayer(params.unicode, params.layerId) },
  { method: 'POST', pattern: 'characters/:unicode/layers/:layerId/fetch', handler: ({ ws, params }) => ws.fetchLayer(params.unicode, params.layerId) },
  {
    method: 'POST',
    pattern: 'characters/:unicode/layers/:layerId/apply',
    handler: async ({ ws, params, body }) => {
      const mode = (await body()).mode === 'fit_font' ? 'fit_font' : 'direct'
      return ws.applyLayerToStrokes(params.unicode, params.layerId, mode)
    },
  },
]

// 핸들러가 "없음"을 알릴 때 돌려주는 표식(404로 응답한다).
class NotFound {
  readonly message: string

  constructor(message: string) {
    this.message = message
  }
}

function matchPattern(pattern: string, parts: string[]): Record<string, string> | null {
  const expected = pattern.split('/')
  if (expected.length !== parts.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < expected.length; i++) {
    if (!expected[i].startsWith(':')) {
      if (expected[i] !== parts[i]) return null
      continue
    }
    const name = expected[i].slice(1)
    const value = decodeURIComponent(parts[i])
    if (name === 'unicode' && !value.startsWith(UNICODE_PREFIX)) return null
    params[name] = value
  }
  return params
}

// /api/* 요청을 처리한다. 처리 중 던져진 오류는 400으로 돌려준다.
export async function handleApi(ws: Workspace, request: ApiRequest): Promise<ApiResult> {
  try {
    const parts = request.pathname.split('/').filter(Boolean).slice(1)
    for (const route of ROUTES) {
      if (route.method !== request.method) continue
      const params = matchPattern(route.pattern, parts)
      if (!params) continue
      const result = await route.handler({ ws, params, searchParams: request.searchParams, body: request.readBody })
      return result instanceof NotFound
        ? { status: HTTP_NOT_FOUND, body: { error: result.message } }
        : { status: HTTP_OK, body: result }
    }
    return { status: HTTP_NOT_FOUND, body: { error: NOT_FOUND_API } }
  } catch (error) {
    return { status: HTTP_BAD_REQUEST, body: { error: error instanceof Error ? error.message : '요청을 처리하지 못했습니다.' } }
  }
}
