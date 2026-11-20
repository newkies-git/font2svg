import {
  CAP_TYPES,
  OLLAMA_CHAT_MAX_CONTENT,
  OLLAMA_CHAT_MAX_EDITS,
  OLLAMA_CHAT_MAX_MESSAGES,
  OLLAMA_CHAT_MAX_STROKES,
  OLLAMA_CHAT_TEMPERATURE,
  OLLAMA_TIMEOUT_MS,
} from '../shared/constants.ts'
import type { CapType, ChatContext, ChatEdit, ChatMessage, ChatMode, ChatReply, ChatStrokeSummary, Pt } from '../shared/types.ts'
import { OLLAMA_MODEL, ollamaUrl } from './ids.ts'

export type ChatRequest = {
  model?: string
  mode: ChatMode
  messages: ChatMessage[]
  context?: ChatContext
}

const CHAT_ROLES = new Set(['user', 'assistant'])
const CAP_SET: ReadonlySet<string> = new Set(CAP_TYPES)
const EDIT_OPS = ['set_radical', 'set_cap', 'reverse', 'move', 'delete', 'merge_next'] as const
// 번호가 밀리는 수정. 한 번에 하나만 받아들여 번호가 어긋나는 일을 막는다.
const STRUCTURAL_OPS: ReadonlySet<string> = new Set(['move', 'delete', 'merge_next'])

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

function parsePoint(value: unknown): Pt {
  const point = Array.isArray(value) ? value : []
  return [finite(point[0]) ?? 0, finite(point[1]) ?? 0]
}

function parseStroke(value: unknown): ChatStrokeSummary | null {
  if (!isRecord(value)) return null
  const order = finite(value.order)
  if (order === null) return null
  const cap = (raw: unknown): CapType => (typeof raw === 'string' && CAP_SET.has(raw) ? (raw as CapType) : 'NONE')
  return {
    order,
    points: finite(value.points) ?? 0,
    width: finite(value.width) ?? 0,
    is_radical: value.is_radical === 1 ? 1 : 0,
    start_cap: cap(value.start_cap),
    end_cap: cap(value.end_cap),
    start: parsePoint(value.start),
    end: parsePoint(value.end),
  }
}

function parseContext(value: unknown): ChatContext | undefined {
  if (!isRecord(value) || typeof value.char !== 'string' || !value.char) return undefined
  const strokes = (Array.isArray(value.strokes) ? value.strokes : [])
    .slice(0, OLLAMA_CHAT_MAX_STROKES)
    .flatMap((item) => parseStroke(item) ?? [])
  return {
    char: value.char.slice(0, OLLAMA_CHAT_MAX_CONTENT),
    reading: typeof value.reading === 'string' ? value.reading : undefined,
    meaning: typeof value.meaning === 'string' ? value.meaning : undefined,
    layerName: typeof value.layerName === 'string' ? value.layerName : '',
    strokes,
  }
}

// 요청 본문을 검증해 정리한다. 잘못된 값은 오류로 알린다.
export function parseChatRequest(payload: Record<string, unknown>): ChatRequest {
  const raw = Array.isArray(payload.messages) ? payload.messages : []
  const messages = raw.slice(-OLLAMA_CHAT_MAX_MESSAGES).flatMap((item): ChatMessage[] => {
    if (!isRecord(item) || typeof item.role !== 'string' || !CHAT_ROLES.has(item.role) || typeof item.content !== 'string') return []
    const content = item.content.trim().slice(0, OLLAMA_CHAT_MAX_CONTENT)
    return content ? [{ role: item.role as ChatMessage['role'], content }] : []
  })
  if (messages.length === 0 || messages[messages.length - 1].role !== 'user') throw new Error('보낼 메시지가 없습니다.')
  const model = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : undefined
  const mode: ChatMode = payload.mode === 'edit' ? 'edit' : 'chat'
  const context = parseContext(payload.context)
  if (mode === 'edit' && !context) throw new Error('데이터 수정 채팅에는 선택한 글자의 획 정보가 필요합니다.')
  return { model, mode, messages, context }
}

function describeStroke(stroke: ChatStrokeSummary): string {
  const radical = stroke.is_radical ? ', 부수' : ''
  return `${stroke.order}획: 중심선 ${stroke.points}점, 폭 ${stroke.width}, 시작(${stroke.start}) 끝(${stroke.end}), 기필 ${stroke.start_cap}, 수필 ${stroke.end_cap}${radical}`
}

export function buildSystemPrompt(mode: ChatMode, context?: ChatContext): string {
  const lines = ['너는 한자 필순 편집 도구에 붙은 도우미다. 한국어로 간결하게 답한다.']
  if (context) {
    lines.push(
      `현재 한자: ${context.char}${context.reading ? ` (${context.reading})` : ''}${context.meaning ? `, 뜻: ${context.meaning}` : ''}`,
      `편집 중인 레이어: ${context.layerName || '이름 없음'}`,
      context.strokes.length > 0 ? `획 ${context.strokes.length}개:\n${context.strokes.map(describeStroke).join('\n')}` : '획 데이터 없음',
    )
  }
  if (mode === 'edit') {
    lines.push(
      '사용자가 데이터 수정을 요청하면 reply에 설명을 쓰고, edits에 수정 제안을 담는다. 요청이 수정이 아니면 edits는 빈 배열이다.',
      `edits의 op는 ${EDIT_OPS.join(', ')} 중 하나다. stroke는 위 목록의 획 번호다.`,
      'set_radical: value 0 또는 1. set_cap: end는 start 또는 end, value는 ' + CAP_TYPES.join('/') + '. reverse: 중심선 방향 반전. move: delta만큼 순서 이동(정수). delete: 획 삭제. merge_next: 다음 획과 병합.',
      '번호가 바뀌는 move·delete·merge_next는 한 번에 하나만 제안한다. 목록에 없는 획 번호나 모르는 op는 쓰지 않는다.',
    )
  }
  return lines.join('\n')
}

const EDITS_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: [...EDIT_OPS] },
          stroke: { type: 'integer' },
          value: { type: ['integer', 'string'] },
          end: { type: 'string', enum: ['start', 'end'] },
          delta: { type: 'integer' },
        },
        required: ['op', 'stroke'],
      },
    },
  },
  required: ['reply', 'edits'],
}

// 모델이 낸 수정 제안 중 형식·범위가 맞는 것만 남긴다. 번호가 밀리는 수정은 하나만 받는다.
export function sanitizeEdits(raw: unknown, strokeCount: number): ChatEdit[] {
  if (!Array.isArray(raw)) return []
  const edits: ChatEdit[] = []
  let structural = false
  for (const item of raw) {
    if (edits.length >= OLLAMA_CHAT_MAX_EDITS) break
    if (!isRecord(item) || typeof item.op !== 'string') continue
    const stroke = finite(item.stroke)
    if (stroke === null || !Number.isInteger(stroke) || stroke < 1 || stroke > strokeCount) continue
    if (STRUCTURAL_OPS.has(item.op)) {
      if (structural) continue
    }
    switch (item.op) {
      case 'set_radical': {
        const value = Number(item.value)
        if (value === 0 || value === 1) edits.push({ op: 'set_radical', stroke, value })
        break
      }
      case 'set_cap': {
        const value = typeof item.value === 'string' && CAP_SET.has(item.value) ? (item.value as CapType) : null
        if (value && (item.end === 'start' || item.end === 'end')) edits.push({ op: 'set_cap', stroke, end: item.end, value })
        break
      }
      case 'reverse':
        edits.push({ op: 'reverse', stroke })
        break
      case 'move': {
        const delta = finite(item.delta)
        const target = delta === null ? null : stroke + delta
        if (delta !== null && Number.isInteger(delta) && delta !== 0 && target !== null && target >= 1 && target <= strokeCount) {
          edits.push({ op: 'move', stroke, delta })
          structural = true
        }
        break
      }
      case 'delete':
        if (strokeCount > 1) {
          edits.push({ op: 'delete', stroke })
          structural = true
        }
        break
      case 'merge_next':
        if (stroke < strokeCount) {
          edits.push({ op: 'merge_next', stroke })
          structural = true
        }
        break
      default:
        break
    }
  }
  return edits
}

// 로컬 Ollama /api/chat으로 대화한다. 데이터 수정 모드는 JSON({reply, edits})로 답하게 한다.
export async function chatWithOllama(request: ChatRequest): Promise<ChatReply> {
  const model = request.model ?? OLLAMA_MODEL
  const edit = request.mode === 'edit'
  let response: Response
  try {
    response = await fetch(ollamaUrl('/api/chat'), {
      method: 'POST',
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        ...(edit ? { format: EDITS_SCHEMA } : {}),
        options: { temperature: OLLAMA_CHAT_TEMPERATURE },
        messages: [{ role: 'system', content: buildSystemPrompt(request.mode, request.context) }, ...request.messages],
      }),
    })
  } catch (error) {
    throw new Error('로컬 Ollama에 연결할 수 없습니다. Ollama가 실행 중인지 확인하세요.', { cause: error })
  }
  if (!response.ok) throw new Error(`Ollama 서버 응답 오류 (HTTP ${response.status})`)
  const data = (await response.json()) as { message?: { content?: unknown } }
  const content = typeof data.message?.content === 'string' ? data.message.content : ''
  if (!edit) return { reply: content.trim(), edits: [], model }
  try {
    const parsed: unknown = JSON.parse(content)
    const body = isRecord(parsed) ? parsed : {}
    return {
      reply: typeof body.reply === 'string' ? body.reply.trim() : '',
      edits: sanitizeEdits(body.edits, request.context?.strokes.length ?? 0),
      model,
    }
  } catch {
    // 모델이 JSON이 아닌 글로 답한 경우: 제안 없이 글만 돌려준다.
    return { reply: content.trim(), edits: [], model }
  }
}
