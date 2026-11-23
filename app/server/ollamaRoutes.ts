import { parseWriteMode } from '../shared/writeMode.ts'
import { chatWithOllama, parseChatRequest } from './ollamaChat.ts'
import { optionalText, type Route } from './routeKit.ts'

// 로컬 Ollama를 쓰는 API 경로.
export const OLLAMA_ROUTES: Route[] = [
  { method: 'POST', pattern: 'ollama/chat', handler: async ({ ws, body }) => chatWithOllama(parseChatRequest(await body()), ws) },
  {
    method: 'POST',
    pattern: 'ollama/apply-edits',
    handler: async ({ ws, body }) => {
      const payload = await body()
      return ws.applyChatEdits(String(payload.unicode ?? ''), payload.edits)
    },
  },
  { method: 'GET', pattern: 'ollama/status', handler: ({ ws }) => ws.getOllamaStatus() },
  {
    method: 'POST',
    pattern: 'characters/:unicode/ollama-ids',
    handler: async ({ ws, params, body }) => {
      const payload = await body()
      const model = optionalText(payload.model)
      if (payload.mode === 'infer') {
        return ws.inferOllamaIds(params.unicode, {
          model,
          ids: typeof payload.ids === 'string' ? payload.ids : undefined,
        })
      }
      const write = parseWriteMode(payload.write)
      return ws.applyOllamaIds(params.unicode, {
        model,
        ids: optionalText(payload.ids),
        write,
      })
    },
  },
  {
    method: 'POST',
    pattern: 'characters/:unicode/ollama-split',
    handler: async ({ ws, params, body }) => {
      const payload = await body()
      const source = payload.source === 'MMH' ? 'MMH' : 'NAVER'
      const model = optionalText(payload.model)
      const write = parseWriteMode(payload.write)
      return ws.splitFontWithOllama(params.unicode, { source, model, write })
    },
  },
]
