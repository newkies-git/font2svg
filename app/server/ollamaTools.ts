import { CAP_TYPES, OLLAMA_CHAT_LIST_DEFAULT, OLLAMA_CHAT_LIST_MAX } from '../shared/constants.ts'
import type { ChatProposal } from '../shared/types.ts'
import { EDIT_OPS, sanitizeEdits, strokesFingerprint } from './strokeEdits.ts'
import type { Workspace } from './workspace.ts'

// 채팅 모델이 부를 수 있는 도구. DB를 직접 열어 주지 않고 작업 공간의 조회 함수만 거친다.
// 쓰기는 하지 않는다: 수정은 제안으로 모아 두고, 사용자가 승인하면 별도 API가 반영한다.
export type ChatToolHost = Pick<Workspace, 'listCharacters' | 'getCharacter'>

type ToolSpec = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }

const READ_TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'list_characters',
      description: '한자 목록을 검색한다. q는 한자·음·뜻·유니코드 일부. 결과는 요약만 준다.',
      parameters: {
        type: 'object',
        properties: { q: { type: 'string' }, limit: { type: 'integer' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_character',
      description: '한 글자의 정보와 현재 획 목록(획 번호는 1부터)을 조회한다. 한자(char) 또는 유니코드(unicode, 예 U+4E01) 중 하나를 준다.',
      parameters: { type: 'object', properties: { char: { type: 'string' }, unicode: { type: 'string' } } },
    },
  },
]

const PROPOSE_TOOL: ToolSpec = {
  type: 'function',
  function: {
    name: 'propose_stroke_edits',
    description: `한 글자의 획 데이터 수정을 제안한다. 바로 저장되지 않고 사용자가 승인해야 반영된다. 먼저 get_character로 획 번호를 확인한다. 번호가 밀리는 move·delete·merge_next는 한 번에 하나만 담는다.`,
    parameters: {
      type: 'object',
      properties: {
        char: { type: 'string' },
        unicode: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: [...EDIT_OPS] },
              stroke: { type: 'integer', description: '획 번호(1부터)' },
              value: { type: ['integer', 'string'], description: `set_radical은 0/1, set_cap은 ${CAP_TYPES.join('/')}` },
              end: { type: 'string', enum: ['start', 'end'], description: 'set_cap에서 기필(start)/수필(end)' },
              delta: { type: 'integer', description: 'move에서 옮길 칸 수' },
            },
            required: ['op', 'stroke'],
          },
        },
      },
      required: ['edits'],
    },
  },
}

export const toolSpecs = (canPropose: boolean): ToolSpec[] => (canPropose ? [...READ_TOOLS, PROPOSE_TOOL] : READ_TOOLS)

const UNICODE_HEX_PAD = 4

// 한자 한 글자 또는 U+코드를 DB의 unicode 값(U+4E01)으로 바꾼다.
function unicodeOf(args: Record<string, unknown>): string | null {
  if (typeof args.unicode === 'string' && /^U\+[0-9A-Fa-f]{4,6}$/.test(args.unicode.trim())) return args.unicode.trim().toUpperCase()
  const char = typeof args.char === 'string' ? [...args.char.trim()][0] : undefined
  const code = char?.codePointAt(0)
  return code === undefined ? null : `U+${code.toString(16).toUpperCase().padStart(UNICODE_HEX_PAD, '0')}`
}

const strokeSummary = (stroke: { median_points: [number, number][]; stroke_width: number; is_radical: 0 | 1; start_cap_type: string; end_cap_type: string }, index: number) => ({
  order: index + 1,
  points: stroke.median_points.length,
  width: stroke.stroke_width,
  is_radical: stroke.is_radical,
  start_cap: stroke.start_cap_type,
  end_cap: stroke.end_cap_type,
  start: stroke.median_points[0] ?? null,
  end: stroke.median_points[stroke.median_points.length - 1] ?? null,
})

export type ToolOutcome = { result: unknown; log: string }

// 도구 하나를 실행한다. 오류는 던지지 않고 결과에 담아 모델이 고쳐 부르게 한다.
export function runChatTool(host: ChatToolHost, name: string, args: Record<string, unknown>, proposals: ChatProposal[], canPropose: boolean): ToolOutcome {
  try {
    if (name === 'list_characters') {
      const requested = typeof args.limit === 'number' && Number.isInteger(args.limit) ? args.limit : OLLAMA_CHAT_LIST_DEFAULT
      const limit = Math.max(1, Math.min(OLLAMA_CHAT_LIST_MAX, requested))
      const q = typeof args.q === 'string' ? args.q : ''
      const rows = host.listCharacters(q)
      const items = rows.slice(0, limit).map((row) => ({
        unicode: row.unicode, char: row.char, reading: row.reading, meaning: row.meaning, stroke_count: row.stroke_count, status: row.issue_status,
      }))
      return { result: { total: rows.length, items }, log: `글자 검색 "${q}"` }
    }
    if (name === 'get_character' || name === 'propose_stroke_edits') {
      const unicode = unicodeOf(args)
      const detail = unicode ? host.getCharacter(unicode) : null
      if (!detail) return { result: { error: '없는 글자입니다.' }, log: `${name} 실패(없는 글자)` }
      if (name === 'get_character') {
        return {
          result: {
            unicode: detail.unicode, char: detail.char, reading: detail.reading, meaning: detail.meaning, grade: detail.grade,
            working: detail.working, status: detail.issue_status, strokes: detail.strokes.map(strokeSummary),
          },
          log: `글자 조회 ${detail.char}`,
        }
      }
      if (!canPropose) return { result: { error: '이 모드에서는 수정을 제안할 수 없습니다.' }, log: '수정 제안 거부(일반 채팅)' }
      const edits = sanitizeEdits(args.edits, detail.strokes.length)
      if (edits.length === 0) return { result: { error: '유효한 수정이 없습니다. 획 번호와 op를 확인하세요.' }, log: `수정 제안 실패 ${detail.char}` }
      proposals.push({ unicode: String(detail.unicode), char: String(detail.char), edits, fingerprint: strokesFingerprint(detail.strokes) })
      return { result: { ok: true, accepted: edits.length, note: '사용자가 승인하면 적용된다.' }, log: `수정 제안 ${detail.char} ${edits.length}건` }
    }
    return { result: { error: `알 수 없는 도구: ${name}` }, log: `알 수 없는 도구 ${name}` }
  } catch (error) {
    return { result: { error: error instanceof Error ? error.message : '도구 실행에 실패했습니다.' }, log: `${name} 오류` }
  }
}
