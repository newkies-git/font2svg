import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ServerResponse } from 'node:http'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import { isLoopbackAddress, readJsonBody } from './server/http.ts'
import { HTTP_FORBIDDEN, handleApi } from './server/routes.ts'
import { getWorkspace } from './server/workspace.ts'

const appDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(appDir, '..')

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function workspaceApi(): Plugin {
  const ws = getWorkspace(rootDir)
  return {
    name: 'hanja-workspace-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (!url.pathname.startsWith('/api/')) return next()
        if (!isLoopbackAddress(req.socket.remoteAddress)) {
          return send(res, HTTP_FORBIDDEN, { error: '이 API는 같은 컴퓨터에서만 쓸 수 있습니다.' })
        }
        const result = await handleApi(ws, {
          method: req.method ?? 'GET',
          pathname: url.pathname,
          searchParams: url.searchParams,
          readBody: () => readJsonBody(req),
        })
        send(res, result.status, result.body)
      })
    },
  }
}

export default defineConfig({
  plugins: [vue(), workspaceApi()],
})
