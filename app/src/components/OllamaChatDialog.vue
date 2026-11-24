<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { OLLAMA_CHAT_MAX_CONTENT } from '../../shared/constants.ts'
import type { ChatMessage, ChatMode, ChatProposal } from '../../shared/types.ts'
import { applyChatEdits, chatWithOllama } from '../lib/api.ts'
import { describeEdit } from '../lib/chatEdits.ts'
import { useOllamaStatus } from '../composables/useOllamaStatus.ts'

type Turn = ChatMessage & { toolLog?: string[]; proposals?: (ChatProposal & { state: 'pending' | 'applied' })[] }

const props = defineProps<{
  selected: { unicode: string; char: string } | null
  // 선택한 글자에 저장하지 않은 편집이 있는지(DB 기준으로 적용하므로 덮어쓰기를 막는다)
  dirty: boolean
}>()

const emit = defineEmits<{ applied: [unicode: string] }>()

const dialog = ref<HTMLDialogElement | null>(null)
const log = ref<HTMLElement | null>(null)
const { status, checking, selectedModel, availableModels, statusError, refreshStatus } = useOllamaStatus()
const mode = ref<ChatMode>('chat')
const turns = ref<Turn[]>([])
const draft = ref('')
const sending = ref(false)
const failure = ref('')

const canSend = computed(() => Boolean(draft.value.trim()) && !sending.value && Boolean(status.value?.connected))

async function open() {
  dialog.value?.show()
  await refreshStatus()
}

function close() {
  dialog.value?.close()
}

async function scrollToEnd() {
  await nextTick()
  if (log.value) log.value.scrollTop = log.value.scrollHeight
}

async function send() {
  const text = draft.value.trim()
  if (!text || sending.value) return
  failure.value = ''
  turns.value.push({ role: 'user', content: text })
  draft.value = ''
  sending.value = true
  await scrollToEnd()
  try {
    const result = await chatWithOllama({
      model: selectedModel.value.trim() || undefined,
      mode: mode.value,
      messages: turns.value.map(({ role, content }) => ({ role, content })),
      current: props.selected ?? undefined,
    })
    turns.value.push({
      role: 'assistant',
      content: result.reply || '(응답이 비었습니다)',
      toolLog: result.toolLog,
      proposals: result.proposals.map((proposal) => ({ ...proposal, state: 'pending' })),
    })
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : 'Ollama 채팅에 실패했습니다.'
  } finally {
    sending.value = false
    await scrollToEnd()
  }
}

const blockedReason = (proposal: ChatProposal) =>
  props.dirty && proposal.unicode === props.selected?.unicode ? '저장하지 않은 편집이 있어 적용할 수 없습니다. 먼저 저장하거나 되돌리세요.' : ''

async function applyProposal(proposal: Turn['proposals'] extends (infer P)[] | undefined ? P : never) {
  if (proposal.state !== 'pending' || blockedReason(proposal)) return
  failure.value = ''
  try {
    await applyChatEdits(proposal.unicode, proposal.edits, proposal.fingerprint)
    proposal.state = 'applied'
    emit('applied', proposal.unicode)
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : 'Ollama 제안을 적용하지 못했습니다.'
  }
}

function clearTurns() {
  turns.value = []
  failure.value = ''
}

defineExpose({ open })
</script>

<template>
  <dialog ref="dialog" class="ollama-chat" aria-labelledby="ollama-chat-title">
    <div class="ollama-chat-head">
      <h3 id="ollama-chat-title">Ollama 채팅</h3>
      <span class="ollama-status-pill" :class="status?.connected ? 'is-ok' : 'is-off'">
        <span class="ollama-dot" aria-hidden="true" />
        <span>{{ checking ? '확인 중…' : status?.connected ? '연결됨' : '미연결' }}</span>
      </span>
      <button type="button" class="ollama-chat-close" aria-label="채팅 닫기" @click="close">닫기</button>
    </div>

    <div class="ollama-chat-options">
      <label>
        모드
        <select v-model="mode" name="chat-mode">
          <option value="chat">일반 채팅 (DB 읽기)</option>
          <option value="edit">데이터 수정 채팅 (읽기 + 수정 제안)</option>
        </select>
      </label>
      <label>
        모델
        <select v-model="selectedModel" name="chat-model" :disabled="checking">
          <option v-for="modelName in availableModels" :key="modelName" :value="modelName">{{ modelName }}</option>
        </select>
      </label>
      <button type="button" :disabled="turns.length === 0" @click="clearTurns">대화 지우기</button>
    </div>

    <p v-if="status && !status.connected" class="ollama-warn">
      {{ status.error || '로컬 Ollama 서버가 꺼져 있습니다.' }}
      <button type="button" :disabled="checking" @click="refreshStatus">다시 확인</button>
    </p>
    <p class="ollama-chat-hint">
      모델이 글자·획 데이터를 직접 조회해 답합니다.
      <template v-if="mode === 'edit'">수정은 제안으로만 올라오며, [적용]을 누르면 DB의 작업 획에 반영됩니다. 승인된 글자는 이력이 남아 실행 취소할 수 있지만, 승인 전 글자는 작업 데이터를 바로 덮어씁니다.</template>
      <template v-else>이 모드에서는 데이터를 수정하지 않습니다.</template>
    </p>

    <ol ref="log" class="ollama-chat-log" aria-live="polite">
      <li v-if="turns.length === 0" class="ollama-chat-empty">메시지를 입력해 대화를 시작하세요. 예: "丁의 획 정보를 알려줘"</li>
      <li v-for="(turn, index) in turns" :key="index" class="ollama-chat-turn" :class="`is-${turn.role}`">
        <p>{{ turn.content }}</p>
        <p v-if="turn.toolLog?.length" class="ollama-chat-tools">조회: {{ turn.toolLog.join(' · ') }}</p>
        <div v-for="(proposal, proposalIndex) in turn.proposals ?? []" :key="proposalIndex" class="ollama-chat-edits">
          <strong>수정 제안 · {{ proposal.char }} ({{ proposal.unicode }})</strong>
          <ul>
            <li v-for="(edit, editIndex) in proposal.edits" :key="editIndex">{{ describeEdit(edit) }}</li>
          </ul>
          <p v-if="blockedReason(proposal) && proposal.state === 'pending'" class="ollama-chat-hint">{{ blockedReason(proposal) }}</p>
          <button
            type="button"
            class="primary"
            :disabled="proposal.state === 'applied' || Boolean(blockedReason(proposal))"
            @click="applyProposal(proposal)"
          >
            {{ proposal.state === 'applied' ? '적용함' : '적용' }}
          </button>
        </div>
      </li>
      <li v-if="sending" class="ollama-chat-turn is-assistant"><p>생각 중…</p></li>
    </ol>

    <p v-if="failure || statusError" class="error" role="alert">{{ failure || statusError }}</p>

    <form class="ollama-chat-form" @submit.prevent="send">
      <textarea
        v-model="draft"
        name="chat-message"
        rows="2"
        :maxlength="OLLAMA_CHAT_MAX_CONTENT"
        placeholder="메시지 입력 (Enter 전송, Shift+Enter 줄바꿈)"
        @keydown.enter.exact.prevent="send"
      />
      <button type="submit" class="primary" :disabled="!canSend">보내기</button>
    </form>
  </dialog>
</template>
