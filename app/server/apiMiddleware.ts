import type { IncomingMessage, ServerResponse } from 'node:http'
import { warnOnce } from '../shared/log.ts'
import { HTTP_BAD_REQUEST, HTTP_FORBIDDEN, HTTP_INTERNAL_ERROR, isLoopbackAddress, readJsonBody } from './http.ts'
import { handleApi } from './routes.ts'
import type { Workspace } from './workspace.ts'

const API_PREFIX = '/api/'
const FORBIDDEN_MESSAGE = '이 API는 같은 컴퓨터에서만 쓸 수 있습니다.'
const BAD_URL_MESSAGE = '요청 주소가 올바르지 않습니다.'
const INTERNAL_MESSAGE = '요청을 처리하지 못했습니다.'
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', JSON_CONTENT_TYPE)
  res.end(JSON.stringify(body))
}

function parseUrl(raw: string | undefined): URL | null {
  try {
    return new URL(raw ?? '/', 'http://localhost')
  } catch {
    return null
  }
}

async function handle(ws: Workspace, req: IncomingMessage, res: ServerResponse, next: () => void) {
  const url = parseUrl(req.url)
  if (!url) return send(res, HTTP_BAD_REQUEST, { error: BAD_URL_MESSAGE })
  if (!url.pathname.startsWith(API_PREFIX)) return next()
  if (!isLoopbackAddress(req.socket.remoteAddress)) return send(res, HTTP_FORBIDDEN, { error: FORBIDDEN_MESSAGE })
  const result = await handleApi(ws, {
    method: req.method ?? 'GET',
    pathname: url.pathname,
    searchParams: url.searchParams,
    readBody: () => readJsonBody(req),
  })
  send(res, result.status, result.body)
}

// /api/* 요청만 작업 공간으로 넘기는 connect 미들웨어. 같은 컴퓨터(루프백)에서 온 요청만 받고, 그 밖의 경로는 next로 넘긴다.
// connect는 Promise를 기다리지 않으므로, 예상하지 못한 오류가 처리되지 않은 rejection으로 남지 않게 여기서 잡아 500으로 알린다.
export function createApiMiddleware(ws: Workspace) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    handle(ws, req, res, next).catch((error: unknown) => {
      warnOnce('api-middleware', error)
      if (res.headersSent) res.end()
      else send(res, HTTP_INTERNAL_ERROR, { error: INTERNAL_MESSAGE })
    })
  }
}
