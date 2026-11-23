import type { AppliedCharacterDetail, ChatCurrent, ChatEdit, ChatMessage, ChatMode, ChatReply, ConversionRecord, OllamaIdsPreview, OllamaStatus, WriteMode } from '../../shared/types.ts'

const API_ROOT = '/api'

type RequestInitLite = {
  method?: 'GET' | 'POST' | 'DELETE'
  // 있으면 JSON으로 보낸다.
  body?: unknown
  signal?: AbortSignal
}

// /api/characters/{unicode}/{segments...} — 각 구간을 URL 인코딩한다.
export function characterUrl(unicode: string, ...segments: string[]): string {
  return [API_ROOT, 'characters', unicode, ...segments].map((part, index) => (index < 2 ? part : encodeURIComponent(part))).join('/')
}

export function apiUrl(...segments: string[]): string {
  return [API_ROOT, ...segments].join('/')
}

// JSON API 호출. 실패(비 2xx)하면 서버의 error 메시지를, 없으면 fallbackMessage를 담은 Error를 던진다.
export async function apiRequest<T = unknown>(url: string, fallbackMessage: string, init: RequestInitLite = {}): Promise<T> {
  const hasBody = init.body !== undefined
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(init.body) : undefined,
    signal: init.signal,
  })
  const payload = await response.json()
  if (!response.ok) throw new Error((payload as { error?: string }).error ?? fallbackMessage)
  return payload as T
}

export function fetchOllamaStatus(): Promise<OllamaStatus> {
  return apiRequest<OllamaStatus>(apiUrl('ollama', 'status'), '로컬 Ollama 연결 상태를 확인하지 못했습니다.')
}

export function chatWithOllama(
  payload: { model?: string; mode: ChatMode; messages: ChatMessage[]; current?: ChatCurrent },
  signal?: AbortSignal,
): Promise<ChatReply> {
  return apiRequest<ChatReply>(apiUrl('ollama', 'chat'), 'Ollama 채팅에 실패했습니다.', { method: 'POST', body: payload, signal })
}

export function applyChatEdits(unicode: string, edits: ChatEdit[]): Promise<AppliedCharacterDetail> {
  return apiRequest(apiUrl('ollama', 'apply-edits'), 'Ollama 제안을 적용하지 못했습니다.', { method: 'POST', body: { unicode, edits } })
}

export function inferOllamaIds(
  unicode: string,
  payload: { model?: string; ids?: string },
): Promise<OllamaIdsPreview> {
  return apiRequest<OllamaIdsPreview>(
    characterUrl(unicode, 'ollama-ids'),
    'Ollama IDS 추론에 실패했습니다.',
    { method: 'POST', body: { mode: 'infer', ...payload } },
  )
}

export function applyOllamaIds(
  unicode: string,
  payload: { model?: string; ids?: string; write?: WriteMode },
): Promise<AppliedCharacterDetail & { ids?: string; model?: string }> {
  return apiRequest(
    characterUrl(unicode, 'ollama-ids'),
    'Ollama IDS 획 합성에 실패했습니다.',
    { method: 'POST', body: { mode: 'apply', ...payload } },
  )
}

export function splitFontWithOllama(
  unicode: string,
  payload: { source: 'NAVER' | 'MMH'; model?: string; write?: WriteMode },
): Promise<AppliedCharacterDetail & { source?: 'NAVER' | 'MMH'; model?: string }> {
  return apiRequest(
    characterUrl(unicode, 'ollama-split'),
    'Ollama 궁서체 획 분리에 실패했습니다.',
    { method: 'POST', body: payload },
  )
}

export function fetchConversions(unicode: string): Promise<ConversionRecord[]> {
  return apiRequest<ConversionRecord[]>(
    characterUrl(unicode, 'conversions'),
    '이미지 변환 이력을 불러오지 못했습니다.',
  )
}
