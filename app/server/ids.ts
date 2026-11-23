import { warnOnce } from '../shared/log.ts'
import path from 'node:path'
import { OLLAMA_TIMEOUT_MS } from '../shared/constants.ts'
import type { Box } from './geometry.ts'

export const IDS_FILE = path.join('database', 'IDS.TXT')

// 공개 IDS에 없는 글자를 사람이 직접 적어 두는 곳.
export const IDS_BOOK: Record<string, string> = {
  畓: '⿱水田',
}

// IDS 부품으로 쓰이는 변형 부수 → DB에 획이 있는 원래 글자.
export const LEAF_FORMS: Record<string, string> = {
  亻: '人', 氵: '水', 忄: '心', 扌: '手', 犭: '犬', 礻: '示', 衤: '衣', 刂: '刀', 釒: '金', 艹: '艸', 灬: '火', 辶: '辵', 糹: '糸', 飠: '食',
}

const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434'
const DEFAULT_OLLAMA_PORT = '11434'
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
export const OLLAMA_MODEL = 'qwen3.5:9b'
const OLLAMA_SEED = 1
const OLLAMA_STATUS_TIMEOUT_MS = 3000
const OLLAMA_IDS_SCHEMA = {
  type: 'object',
  properties: { ids: { type: 'string' } },
  required: ['ids'],
}

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

export function ollamaUrl(endpoint: '/api/generate' | '/api/tags' | '/api/chat'): string {
  return `${resolveOllamaBaseUrl()}${endpoint}`
}

// 로컬 Ollama에 JSON 본문을 POST한다. 응답 상태·연결 오류 처리는 호출한 쪽이 맡는다.
export function postOllama(endpoint: '/api/generate' | '/api/chat', body: Record<string, unknown>): Promise<Response> {
  return fetch(ollamaUrl(endpoint), {
    method: 'POST',
    signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

export const WHOLE_BOX: Box = [0, 0, 1, 1]
const THIRD = 1 / 3
// 부품 배치 칸: [왼쪽, 아래, 오른쪽, 위] (0~1, 세로는 아래가 0). 감싸는 구조는 바깥 부품이 전체, 안쪽 부품이 가운데 칸을 쓴다.
export const IDS_LAYOUTS: Record<string, Box[]> = {
  '⿰': [[0, 0, 0.5, 1], [0.5, 0, 1, 1]],
  '⿱': [[0, 0.5, 1, 1], [0, 0, 1, 0.5]],
  '⿲': [[0, 0, THIRD, 1], [THIRD, 0, 2 * THIRD, 1], [2 * THIRD, 0, 1, 1]],
  '⿳': [[0, 2 * THIRD, 1, 1], [0, THIRD, 1, 2 * THIRD], [0, 0, 1, THIRD]],
  '⿴': [WHOLE_BOX, [0.2, 0.2, 0.8, 0.8]],
  '⿵': [WHOLE_BOX, [0.2, 0, 0.8, 0.75]],
  '⿶': [WHOLE_BOX, [0.2, 0.25, 0.8, 1]],
  '⿷': [WHOLE_BOX, [0.25, 0.2, 1, 0.8]],
  '⿸': [WHOLE_BOX, [0.3, 0, 1, 0.7]],
  '⿹': [WHOLE_BOX, [0, 0, 0.7, 0.7]],
  '⿺': [WHOLE_BOX, [0.3, 0.3, 1, 1]],
  '⿻': [WHOLE_BOX, WHOLE_BOX],
}

export type IdsNode = { leaf: string } | { op: string; children: IdsNode[] }
export const IDS_OPERATOR = /[\u2FF0-\u2FFF]/
const IDS_UNSUPPORTED = /[{}\\&;]/

// IDS 문자열을 트리로 바꾼다. 지원하지 않는 연산자·조합 표기가 있거나 문자열이 남으면 null.
export function parseIds(ids: string): IdsNode | null {
  if (IDS_UNSUPPORTED.test(ids)) return null
  const tokens = [...ids]
  let index = 0
  const read = (): IdsNode | null => {
    const token = tokens[index++]
    if (token === undefined) return null
    const layout = IDS_LAYOUTS[token]
    if (!layout) return IDS_OPERATOR.test(token) ? null : { leaf: token }
    const children: IdsNode[] = []
    for (let count = 0; count < layout.length; count++) {
      const child = read()
      if (!child) return null
      children.push(child)
    }
    return { op: token, children }
  }
  const node = read()
  return node && index === tokens.length ? node : null
}

// BabelStone IDS.TXT: "U+코드<TAB>글자<TAB>^IDS$(지역)[<TAB>...]". 한국(K) 표기를 먼저 둔다. '*'로 시작하는 동치 표기는 건너뛴다.
export function parseIdsFile(text: string): Map<string, string[]> {
  const index = new Map<string, string[]>()
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const [, char, ...entries] = line.split('\t')
    const found = entries.flatMap((entry) => {
      const match = /^\^(.+)\$\((.*)\)$/.exec(entry)
      return match ? [{ ids: match[1], korean: match[2].includes('K') }] : []
    })
    if (char && found.length > 0) index.set(char, found.sort((a, b) => Number(b.korean) - Number(a.korean)).map((item) => item.ids))
  }
  return index
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

export async function askOllama(char: string, model = OLLAMA_MODEL): Promise<string | null> {
  try {
    const response = await postOllama('/api/generate', {
      model,
      stream: false,
      think: false,
      format: OLLAMA_IDS_SCHEMA,
      options: { temperature: 0, seed: OLLAMA_SEED },
      prompt: `한자 ${char}를 IDS(표의문자 분해)로 나눠라. ids는 IDS 문자열 하나다.\n예) 林 → {"ids":"⿰木木"}\n예) 昌 → {"ids":"⿱日日"}\n예) 謝 → {"ids":"⿰言射"}`,
    })
    if (!response.ok) return null
    const data = await response.json() as { response?: string }
    const parsed = JSON.parse(data.response ?? '') as { ids?: unknown }
    return typeof parsed.ids === 'string' ? parsed.ids : null
  } catch (error) {
    // 로컬 Ollama가 꺼져 있거나 응답이 JSON이 아닌 경우. IDS 추론 없이 계속한다.
    warnOnce('ollama', error)
    return null
  }
}
