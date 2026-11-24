import { OLLAMA_TIMEOUT_MS } from '../shared/constants.ts'

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
const DEFAULT_OLLAMA_PORT = '11434'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
export const OLLAMA_MODEL = 'qwen3.5:9b'
const OLLAMA_STATUS_TIMEOUT_MS = 3000

export function resolveOllamaBaseUrl(rawHost = process.env.OLLAMA_HOST): string {
  const trimmed = rawHost?.trim()
  if (!trimmed) return DEFAULT_OLLAMA_BASE_URL
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('OLLAMA_HOST 형식이 올바르지 않습니다. loopback 주소(127.0.0.1·localhost·[::1])만 허용됩니다.')
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('보안 정책상 로컬 Ollama는 loopback 주소(127.0.0.1·localhost·[::1])만 허용됩니다.')
  }
  if (!parsed.port) parsed.port = DEFAULT_OLLAMA_PORT
  return parsed.origin
}

function ollamaUrl(endpoint: '/api/tags' | '/api/chat'): string {
  return `${resolveOllamaBaseUrl()}${endpoint}`
}

// 로컬 Ollama에 JSON 본문을 POST한다. 응답 상태·연결 오류 처리는 호출한 쪽이 맡는다.
export function postOllama(endpoint: '/api/chat', body: Record<string, unknown>): Promise<Response> {
  return fetch(ollamaUrl(endpoint), {
    method: 'POST',
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export type OllamaStatusResult = {
  connected: boolean
  models: string[]
  defaultModel: string
  url: string
  error?: string
}

export async function listOllamaStatus(): Promise<OllamaStatusResult> {
  let baseUrl = DEFAULT_OLLAMA_BASE_URL
  try {
    baseUrl = resolveOllamaBaseUrl()
    const response = await fetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(OLLAMA_STATUS_TIMEOUT_MS),
    })
    if (!response.ok) {
      return {
        connected: false,
        models: [],
        defaultModel: OLLAMA_MODEL,
        url: baseUrl,
        error: `Ollama 서버 응답 오류 (HTTP ${response.status})`,
      }
    }
    const data = (await response.json()) as { models?: Array<{ name?: unknown }> }
    const allModels = (data.models ?? [])
      .map((item) => (typeof item.name === 'string' ? item.name : ''))
      .filter(Boolean)
    const generationModels = allModels.filter((name) => !name.toLowerCase().includes('embedding'))
    const models = generationModels.length > 0 ? generationModels : allModels
    return {
      connected: true,
      models,
      defaultModel: models.includes(OLLAMA_MODEL) ? OLLAMA_MODEL : (models[0] ?? OLLAMA_MODEL),
      url: baseUrl,
    }
  } catch (error) {
    const isPolicyError = error instanceof Error && (error.message.includes('loopback') || error.message.includes('OLLAMA_HOST'))
    return {
      connected: false,
      models: [],
      defaultModel: OLLAMA_MODEL,
      url: baseUrl,
      error: isPolicyError ? error.message : `로컬 Ollama(${baseUrl})에 연결할 수 없습니다. Ollama가 실행 중인지 확인하세요.`,
    }
  }
}
