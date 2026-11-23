import {
  CAP_TYPES,
  OLLAMA_CHAT_MAX_CONTENT,
  OLLAMA_CHAT_MAX_MESSAGES,
  OLLAMA_CHAT_MAX_TOOL_ROUNDS,
  OLLAMA_CHAT_TEMPERATURE,
} from '../shared/constants.ts'
import { isRecord } from '../shared/guards.ts'
import type { ChatCurrent, ChatMessage, ChatMode, ChatProposal, ChatReply } from '../shared/types.ts'
import { OLLAMA_MODEL, postOllama } from './ids.ts'
import { runChatTool, toolSpecs, type ChatToolHost } from './ollamaTools.ts'
import { EDIT_OPS } from './strokeEdits.ts'

export type ChatRequest = {
  model?: string
  mode: ChatMode
  messages: ChatMessage[]
  current?: ChatCurrent
}

const CHAT_ROLES = new Set(['user', 'assistant'])

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
  const current = isRecord(payload.current) && typeof payload.current.unicode === 'string' && typeof payload.current.char === 'string'
    ? { unicode: payload.current.unicode, char: payload.current.char }
    : undefined
  return { model, mode, messages, current }
}

export function buildSystemPrompt(mode: ChatMode, current?: ChatCurrent): string {
  const lines = [
    '너는 한자 필순 편집 도구에 붙은 도우미다. 한국어로 간결하게 답한다.',
    '글자·획 데이터가 필요하면 추측하지 말고 도구(list_characters, get_character)로 조회한다.',
  ]
  if (current) lines.push(`사용자가 지금 보고 있는 글자: ${current.char} (${current.unicode})`)
  if (mode === 'edit') {
    lines.push(
      '획 데이터 수정 요청은 먼저 get_character로 획 번호를 확인한 뒤 propose_stroke_edits로 제안한다. 제안은 사용자가 승인해야 반영되므로, 반영됐다고 말하지 말고 제안했다고 알린다.',
      `수정 op: ${EDIT_OPS.join(', ')}. set_cap의 value: ${CAP_TYPES.join('/')}. 번호가 바뀌는 move·delete·merge_next는 한 번에 하나만 제안한다.`,
    )
  } else {
    lines.push('이 모드에서는 데이터를 수정할 수 없다. 수정이 필요하면 "데이터 수정 채팅" 모드를 쓰라고 안내한다.')
  }
  return lines.join('\n')
}

type ToolCall = { function?: { name?: unknown; arguments?: unknown } }
type OllamaMessage = { role: string; content?: string; tool_calls?: ToolCall[]; tool_name?: string }

function parseArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw
  if (typeof raw !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function requestChat(model: string, messages: OllamaMessage[], tools: unknown[]): Promise<OllamaMessage> {
  let response: Response
  try {
    response = await postOllama('/api/chat', { model, stream: false, think: false, tools, options: { temperature: OLLAMA_CHAT_TEMPERATURE }, messages })
  } catch (error) {
    throw new Error('로컬 Ollama에 연결할 수 없습니다. Ollama가 실행 중인지 확인하세요.', { cause: error })
  }
  if (!response.ok) throw new Error(`Ollama 서버 응답 오류 (HTTP ${response.status})`)
  const data = (await response.json()) as { message?: OllamaMessage }
  return data.message ?? { role: 'assistant', content: '' }
}

// 로컬 Ollama /api/chat으로 대화한다. 모델이 도구를 부르면 서버가 실행해 결과를 돌려주고 답이 나올 때까지 반복한다.
export async function chatWithOllama(request: ChatRequest, host: ChatToolHost): Promise<ChatReply> {
  const model = request.model ?? OLLAMA_MODEL
  const canPropose = request.mode === 'edit'
  const tools = toolSpecs(canPropose)
  const proposals: ChatProposal[] = []
  const toolLog: string[] = []
  const messages: OllamaMessage[] = [{ role: 'system', content: buildSystemPrompt(request.mode, request.current) }, ...request.messages]
  for (let round = 0; round <= OLLAMA_CHAT_MAX_TOOL_ROUNDS; round++) {
    const answer = await requestChat(model, messages, round < OLLAMA_CHAT_MAX_TOOL_ROUNDS ? tools : [])
    const calls = answer.tool_calls ?? []
    if (calls.length === 0) return { reply: (answer.content ?? '').trim(), proposals, toolLog, model }
    messages.push({ role: 'assistant', content: answer.content ?? '', tool_calls: calls })
    for (const call of calls) {
      const name = typeof call.function?.name === 'string' ? call.function.name : ''
      const outcome = runChatTool(host, name, parseArguments(call.function?.arguments), proposals, canPropose)
      toolLog.push(outcome.log)
      messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(outcome.result) })
    }
  }
  return { reply: '도구 호출이 너무 많아 답을 끝내지 못했습니다. 질문을 나눠 다시 시도하세요.', proposals, toolLog, model }
}
