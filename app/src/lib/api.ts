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
