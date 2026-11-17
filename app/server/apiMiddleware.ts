import type { IncomingMessage, ServerResponse } from 'node:http'
import { HTTP_FORBIDDEN, isLoopbackAddress, readJsonBody } from './http.ts'
import { handleApi } from './routes.ts'
import type { Workspace } from './workspace.ts'

const API_PREFIX = '/api/'
const FORBIDDEN_MESSAGE = '이 API는 같은 컴퓨터에서만 쓸 수 있습니다.'
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', JSON_CONTENT_TYPE)
  res.end(JSON.stringify(body))
}

// /api/* 요청만 작업 공간으로 넘기는 connect 미들웨어. 같은 컴퓨터(루프백)에서 온 요청만 받고, 그 밖의 경로는 next로 넘긴다.
export function createApiMiddleware(ws: Workspace) {
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
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
}
