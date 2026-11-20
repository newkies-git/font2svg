<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { OLLAMA_CHAT_MAX_CONTENT } from '../../shared/constants.ts'
import type { ChatEdit, ChatMessage, ChatMode, LayerRecord } from '../../shared/types.ts'
import { chatWithOllama } from '../lib/api.ts'
import { applyChatEdits, buildChatContext, describeEdit, type ChatEditActions } from '../lib/chatEdits.ts'
import { useOllamaStatus } from '../composables/useOllamaStatus.ts'

type Turn = ChatMessage & { edits?: ChatEdit[]; applied?: boolean }

const props = defineProps<{
  selected: { char: string; reading?: string | null; meaning?: string | null } | null
  layer: Pick<LayerRecord, 'name' | 'strokes'> | null
  locked: boolean
  actions: ChatEditActions
}>()

const dialog = ref<HTMLDialogElement | null>(null)
const log = ref<HTMLElement | null>(null)
const { status, checking, selectedModel, availableModels, statusError, refreshStatus } = useOllamaStatus()
const mode = ref<ChatMode>('chat')
const turns = ref<Turn[]>([])
const draft = ref('')
const sending = ref(false)
const failure = ref('')

const canSend = computed(() => Boolean(draft.value.trim()) && !sending.value && Boolean(status.value?.connected))
const editBlocked = computed(() => mode.value === 'edit' && (!props.selected || !props.layer || props.layer.strokes.length === 0))

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
      context: buildChatContext(props.selected, props.layer),
    })
    turns.value.push({ role: 'assistant', content: result.reply || '(응답이 비었습니다)', edits: result.edits, applied: false })
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : 'Ollama 채팅에 실패했습니다.'
  } finally {
    sending.value = false
    await scrollToEnd()
  }
}

function applyTurn(turn: Turn) {
  if (!turn.edits?.length || turn.applied || props.locked) return
  applyChatEdits(turn.edits, props.actions)
  turn.applied = true
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
          <option value="chat">일반 채팅</option>
          <option value="edit">데이터 수정 채팅</option>
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
    <p v-if="mode === 'edit'" class="ollama-chat-hint">
      <template v-if="editBlocked">수정할 획이 있는 글자와 레이어를 선택하세요.</template>
      <template v-else>
        {{ selected?.char }} · '{{ layer?.name }}' 레이어의 {{ layer?.strokes.length }}획을 대상으로 제안합니다. 제안은 [적용]을 눌러야 반영되고, 저장 전까지 되돌릴 수 있습니다.
      </template>
    </p>

    <ol ref="log" class="ollama-chat-log" aria-live="polite">
      <li v-if="turns.length === 0" class="ollama-chat-empty">메시지를 입력해 대화를 시작하세요.</li>
      <li v-for="(turn, index) in turns" :key="index" class="ollama-chat-turn" :class="`is-${turn.role}`">
        <p>{{ turn.content }}</p>
        <div v-if="turn.edits?.length" class="ollama-chat-edits">
          <strong>수정 제안</strong>
          <ul>
            <li v-for="(edit, editIndex) in turn.edits" :key="editIndex">{{ describeEdit(edit) }}</li>
          </ul>
          <button type="button" class="primary" :disabled="turn.applied || locked" @click="applyTurn(turn)">
            {{ turn.applied ? '적용함' : locked ? '레이어 잠김' : '적용' }}
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
      <button type="submit" class="primary" :disabled="!canSend || editBlocked">보내기</button>
    </form>
  </dialog>
</template>
