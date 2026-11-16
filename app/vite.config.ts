import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import { handleApi } from './server/routes.ts'
import { getWorkspace } from './server/workspace.ts'

const appDir = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(appDir, '..')

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text) return resolve({})
      try {
        resolve(JSON.parse(text) as Record<string, unknown>)
      } catch {
        reject(new Error('JSON 형식이 아닙니다.'))
      }
    })
    req.on('error', reject)
  })
}

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
        const result = await handleApi(ws, {
          method: req.method ?? 'GET',
          pathname: url.pathname,
          searchParams: url.searchParams,
          readBody: () => readBody(req),
        })
        send(res, result.status, result.body)
      })
    },
  }
}

export default defineConfig({
  plugins: [vue(), workspaceApi()],
})
