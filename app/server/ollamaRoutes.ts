import { chatWithOllama, parseChatRequest } from './ollamaChat.ts'
import type { Route } from './routeKit.ts'

// 로컬 Ollama를 쓰는 API 경로.
export const OLLAMA_ROUTES: Route[] = [
  { method: 'POST', pattern: 'ollama/chat', handler: async ({ ws, body }) => chatWithOllama(parseChatRequest(await body()), ws) },
  {
    method: 'POST',
    pattern: 'ollama/apply-edits',
    handler: async ({ ws, body }) => {
      const payload = await body()
      return ws.applyChatEdits(String(payload.unicode ?? ''), payload.edits, payload.fingerprint, payload.confirmWorking)
    },
  },
  { method: 'GET', pattern: 'ollama/status', handler: ({ ws }) => ws.getOllamaStatus() },
]
