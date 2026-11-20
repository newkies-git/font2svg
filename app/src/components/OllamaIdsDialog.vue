<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { CharacterDetail, OllamaIdsPreview, OllamaStatus } from '../../shared/types.ts'
import { fetchOllamaStatus, inferOllamaIds } from '../lib/api.ts'

const IDS_OPERATORS = ['⿰', '⿱', '⿲', '⿳', '⿴', '⿵', '⿶', '⿷', '⿸', '⿹', '⿺', '⿻'] as const
const IME_PROCESSING_KEY_CODE = 229

const props = defineProps<{
  selected: CharacterDetail | null
  busy: boolean
}>()

const emit = defineEmits<{
  apply: [payload: { model?: string; ids?: string }]
  statusUpdated: [status: OllamaStatus]
}>()

const dialog = ref<HTMLDialogElement | null>(null)
const idsInputEl = ref<HTMLInputElement | null>(null)

const status = ref<OllamaStatus | null>(null)
const checking = ref(false)
const inferring = ref(false)
const selectedModel = ref('')
const idsInput = ref('')
const preview = ref<OllamaIdsPreview | null>(null)
const localError = ref('')

const availableModels = computed(() => {
  const list = status.value?.models ?? []
  const fallback = status.value?.defaultModel || 'qwen3.5:9b'
  return list.length > 0 ? list : [fallback]
})

async function refreshStatus() {
  checking.value = true
  localError.value = ''
  try {
    const res = await fetchOllamaStatus()
    status.value = res
    if (!selectedModel.value || (res.models.length > 0 && !res.models.includes(selectedModel.value))) {
      selectedModel.value = res.defaultModel
    }
    emit('statusUpdated', res)
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : 'Ollama 상태를 확인하지 못했습니다.'
  } finally {
    checking.value = false
  }
}

async function open() {
  localError.value = ''
  preview.value = null
  idsInput.value = ''
  dialog.value?.showModal()
  await refreshStatus()
  await nextTick()
  idsInputEl.value?.focus()
}

async function runInfer() {
  if (!props.selected) return
  inferring.value = true
  localError.value = ''
  try {
    const res = await inferOllamaIds(props.selected.unicode, { model: selectedModel.value || undefined })
    preview.value = res
    if (res.ids) {
      idsInput.value = res.ids
    } else {
      localError.value = 'Ollama에서 IDS를 응답받지 못했습니다. 실행 상태나 모델을 확인하거나 IDS를 직접 입력하세요.'
    }
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : 'Ollama IDS 추론에 실패했습니다.'
  } finally {
    inferring.value = false
  }
}

async function checkIds() {
  if (!props.selected) return
  const trimmed = idsInput.value.trim()
  if (!trimmed) {
    preview.value = null
    return
  }
  inferring.value = true
  localError.value = ''
  try {
    preview.value = await inferOllamaIds(props.selected.unicode, { ids: trimmed, model: selectedModel.value || undefined })
  } catch (cause) {
    localError.value = cause instanceof Error ? cause.message : 'IDS 검증에 실패했습니다.'
  } finally {
    inferring.value = false
  }
}

function insertOperator(op: string) {
  const input = idsInputEl.value
  if (!input) {
    idsInput.value += op
    return
  }
  const start = input.selectionStart ?? idsInput.value.length
  const end = input.selectionEnd ?? idsInput.value.length
  idsInput.value = idsInput.value.slice(0, start) + op + idsInput.value.slice(end)
  preview.value = null
  nextTick(() => {
    input.focus()
    input.setSelectionRange(start + op.length, start + op.length)
  })
}

function onIdsKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    if (event.isComposing || event.keyCode === IME_PROCESSING_KEY_CODE) return
    event.preventDefault()
    void checkIds()
  }
}

function submitApply() {
  if (!props.selected) return
  const model = selectedModel.value.trim() || undefined
  const ids = idsInput.value.trim() || undefined
  dialog.value?.close()
  emit('apply', { model, ids })
}

defineExpose({ open })
</script>

<template>
  <dialog
    ref="dialog"
    class="app-dialog ollama-dialog"
    aria-labelledby="ollama-dialog-title"
  >
    <div class="dialog-content">
      <div class="ollama-dialog-head">
        <div>
          <h3 id="ollama-dialog-title">로컬 Ollama IDS 연동</h3>
          <p v-if="selected" class="ollama-char-sub">
            대상 한자: <strong lang="zh-Hani">{{ selected.char }}</strong> ({{ selected.reading ?? '독음 미등록' }} · {{ selected.unicode }})
          </p>
        </div>
        <div class="ollama-conn-wrap">
          <span
            class="ollama-conn-badge"
            :class="status?.connected ? 'is-ok' : 'is-off'"
          >
            <span class="ollama-dot" aria-hidden="true" />
            {{ checking ? '확인 중…' : status?.connected ? '연결됨' : '미연결' }}
          </span>
          <button
            type="button"
            class="ollama-refresh-btn"
            :disabled="checking || inferring"
            title="로컬 Ollama 연결 다시 확인"
            @click="refreshStatus"
          >
            새로고침
          </button>
        </div>
      </div>

      <p v-if="status && !status.connected" class="ollama-warn">
        {{ status.error || '로컬 Ollama 서버(127.0.0.1:11434)가 꺼져 있습니다.' }}
        터미널에서 <code>ollama serve</code>를 실행한 뒤 새로고침하세요. (직접 IDS 입력은 오프라인에서도 가능합니다.)
      </p>

      <div class="ollama-field">
        <label for="ollama-model-select">로컬 모델</label>
        <div class="ollama-row">
          <select
            id="ollama-model-select"
            v-model="selectedModel"
            name="model"
            :disabled="checking || inferring"
          >
            <option v-for="modelName in availableModels" :key="modelName" :value="modelName">
              {{ modelName }}
            </option>
          </select>
          <button
            type="button"
            class="primary"
            :disabled="!selected || !status?.connected || inferring || busy"
            @click="runInfer"
          >
            {{ inferring ? '추론 중…' : 'Ollama로 IDS 추론' }}
          </button>
        </div>
      </div>

      <div class="ollama-field">
        <label for="ollama-ids-input">IDS 구조식 (직접 수정 가능)</label>
        <div class="ollama-row">
          <input
            id="ollama-ids-input"
            ref="idsInputEl"
            v-model="idsInput"
            name="ids"
            type="text"
            placeholder="예: ⿰木木, ⿱水田"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            enterkeyhint="done"
            @input="preview = null"
            @keydown="onIdsKeyDown"
          />
          <button
            type="button"
            :disabled="!selected || !idsInput.trim() || inferring"
            @click="checkIds"
          >
            합성 확인
          </button>
        </div>

        <div class="ids-op-bar" role="group" aria-label="IDS 구조 연산자 삽입">
          <button
            v-for="op in IDS_OPERATORS"
            :key="op"
            type="button"
            class="ids-op-btn"
            :title="`연산자 ${op} 삽입`"
            @click="insertOperator(op)"
          >
            {{ op }}
          </button>
        </div>
      </div>

      <div v-if="preview" class="ollama-preview" :class="preview.composable ? 'is-ready' : 'is-fail'" role="status" aria-live="polite">
        <template v-if="preview.composable">
          ✓ 유효한 IDS (<code>{{ preview.ids }}</code>) · DB 부품 합성 가능 (예상 <strong>{{ preview.strokeCount }}획</strong>)
        </template>
        <template v-else-if="preview.valid">
          ⚠ IDS 문법(<code>{{ preview.ids }}</code>)은 맞지만, 일부 부품의 획 데이터가 DB에 없어 합성할 수 없습니다.
        </template>
        <template v-else>
          ✕ 올바른 IDS 구조식이 아닙니다. (예: <code>⿰木木</code>, <code>⿱水田</code>)
        </template>
      </div>

      <p v-if="localError" class="error" role="alert">{{ localError }}</p>

      <form method="dialog" class="dialog-actions">
        <button type="submit" value="cancel">닫기</button>
        <button
          type="button"
          class="primary"
          :disabled="!selected || inferring || busy || (!idsInput.trim() && !status?.connected)"
          @click="submitApply"
        >
          작업 획에 적용
        </button>
      </form>
    </div>
  </dialog>
</template>
