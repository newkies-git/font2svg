import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import vue from '@vitejs/plugin-vue'
import type { Plugin } from 'vite'
import { defineConfig } from 'vite'
import { ACJK_BATCH_LIMIT, FONT_BATCH_LIMIT, MISSING_FETCH_LIMIT } from './src/lib/constants.ts'
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
        try {
          const parts = url.pathname.split('/').filter(Boolean)
          if (req.method === 'GET' && url.pathname === '/api/characters') {
            return send(res, 200, ws.listCharacters(url.searchParams.get('q') ?? ''))
          }
          if (req.method === 'GET' && url.pathname === '/api/radicals') {
            return send(res, 200, ws.listRadicals())
          }
          if (req.method === 'POST' && url.pathname === '/api/import') {
            const body = await readBody(req)
            const entries = Array.isArray(body) ? body : body.entries
            return send(res, 200, ws.importInitial(entries))
          }
          if (req.method === 'POST' && url.pathname === '/api/sync-missing') {
            const body = await readBody(req)
            const limit = Number(body.limit ?? MISSING_FETCH_LIMIT)
            return send(res, 200, await ws.syncMissing(Number.isFinite(limit) ? limit : MISSING_FETCH_LIMIT))
          }
          if (req.method === 'POST' && url.pathname === '/api/apply-font') {
            const body = await readBody(req)
            const limit = Number(body.limit ?? FONT_BATCH_LIMIT)
            return send(res, 200, ws.applyFontBatch(String(body.after ?? ''), Number.isFinite(limit) ? limit : FONT_BATCH_LIMIT))
          }
          if (req.method === 'POST' && url.pathname === '/api/apply-acjk') {
            const body = await readBody(req)
            const limit = Number(body.limit ?? ACJK_BATCH_LIMIT)
            return send(res, 200, await ws.applyAcjkBatch(String(body.after ?? ''), Number.isFinite(limit) ? limit : ACJK_BATCH_LIMIT))
          }
          const unicode = decodeURIComponent(parts[2] ?? '')
          if (parts[1] !== 'characters' || !unicode.startsWith('U+')) {
            return send(res, 404, { error: '없는 API입니다.' })
          }
          if (req.method === 'GET' && parts.length === 3) {
            const row = ws.getCharacter(unicode)
            return row ? send(res, 200, row) : send(res, 404, { error: '없는 글자입니다.' })
          }
          if (req.method === 'POST' && parts[3] === 'strokes') {
            const body = await readBody(req)
            return send(res, 200, ws.updateStrokes(unicode, body.strokes as never, String(body.action ?? '편집')))
          }
          if (req.method === 'POST' && parts[3] === 'import-svg') {
            const body = await readBody(req)
            return send(res, 200, ws.importSvg(unicode, String(body.svg ?? '')))
          }
          if (req.method === 'POST' && parts[3] === 'approve') {
            return send(res, 200, ws.approve(unicode))
          }
          if (req.method === 'POST' && parts[3] === 'undo') {
            return send(res, 200, ws.undo(unicode))
          }
          if (req.method === 'POST' && parts[3] === 'reference') {
            return send(res, 200, await ws.ensureReference(unicode))
          }
          if (req.method === 'POST' && parts[3] === 'apply-naver') {
            return send(res, 200, await ws.applyNaver(unicode))
          }
          if (req.method === 'POST' && parts[3] === 'compile') {
            return send(res, 200, ws.compile(unicode))
          }
          if (req.method === 'POST' && parts[3] === 'layers-meta') {
            const body = await readBody(req)
            return send(res, 200, ws.updateLayersMeta(unicode, body.patches as never))
          }
          if (req.method === 'POST' && parts[3] === 'resegment') {
            const body = await readBody(req)
            return send(res, 200, ws.resegmentLayer(unicode, body.medians))
          }
          if (req.method === 'POST' && parts[3] === 'layers' && parts.length === 4) {
            const body = await readBody(req)
            return send(
              res,
              200,
              ws.duplicateLayer(
                unicode,
                typeof body.sourceLayerId === 'string' ? body.sourceLayerId : undefined,
                typeof body.name === 'string' ? body.name : undefined,
              ),
            )
          }
          if (parts[3] === 'layers' && parts[4]) {
            const layerId = decodeURIComponent(parts[4])
            const subAction = parts[5]
            if (req.method === 'DELETE' && !subAction) {
              return send(res, 200, ws.deleteLayer(unicode, layerId))
            }
            if (req.method === 'POST' && subAction === 'save') {
              const body = await readBody(req)
              return send(res, 200, ws.saveLayer(unicode, layerId, {
                strokes: body.strokes,
                paths: body.paths,
                action: typeof body.action === 'string' ? body.action : undefined,
              }))
            }
            if (req.method === 'POST' && subAction === 'reset') {
              return send(res, 200, ws.resetLayer(unicode, layerId))
            }
            if (req.method === 'POST' && subAction === 'fetch') {
              return send(res, 200, await ws.fetchLayer(unicode, layerId))
            }
            if (req.method === 'POST' && subAction === 'apply') {
              const body = await readBody(req)
              const mode = body.mode === 'fit_font' ? 'fit_font' : 'direct'
              return send(res, 200, ws.applyLayerToStrokes(unicode, layerId, mode))
            }
          }
          return send(res, 404, { error: '없는 API입니다.' })
        } catch (error) {
          send(res, 400, { error: error instanceof Error ? error.message : '요청을 처리하지 못했습니다.' })
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [vue(), workspaceApi()],
})
