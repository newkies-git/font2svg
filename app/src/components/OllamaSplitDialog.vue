<script setup lang="ts">
import { computed, ref } from 'vue'
import { LAYER_ID } from '../../shared/constants.ts'
import type { CharacterDetail } from '../../shared/types.ts'
import { useOllamaStatus } from '../composables/useOllamaStatus.ts'

const props = defineProps<{
  selected: CharacterDetail | null
  fontContourCount: number
  busy: boolean
}>()

const emit = defineEmits<{
  split: [payload: { source: 'NAVER' | 'MMH'; model?: string }]
}>()

const dialog = ref<HTMLDialogElement | null>(null)
const { status, checking, selectedModel, availableModels, statusError, refreshStatus } = useOllamaStatus()
const selectedSource = ref<'NAVER' | 'MMH'>('NAVER')

const naverStrokeCount = computed(() => props.selected?.layers.find((l) => l.id === LAYER_ID.naver)?.strokes.length ?? 0)
const mmhStrokeCount = computed(() => props.selected?.layers.find((l) => l.id === LAYER_ID.mmh)?.strokes.length ?? 0)

async function open() {
  if (naverStrokeCount.value === 0 && mmhStrokeCount.value > 0) {
    selectedSource.value = 'MMH'
  } else {
    selectedSource.value = 'NAVER'
  }
  if (dialog.value) dialog.value.returnValue = ''
  dialog.value?.showModal()
  await refreshStatus()
}

function submitSplit() {
  if (!props.selected || props.fontContourCount === 0) return
  const model = selectedModel.value.trim() || undefined
  const source = selectedSource.value
  dialog.value?.close()
  emit('split', { source, model })
}

defineExpose({ open })
</script>

<template>
  <dialog
    ref="dialog"
    class="app-dialog ollama-dialog"
    aria-labelledby="ollama-split-title"
  >
    <div class="dialog-content">
      <div class="ollama-dialog-head">
        <div>
          <h3 id="ollama-split-title">Ollama 궁서체 획 분리</h3>
          <p v-if="selected" class="ollama-char-sub">
            선택 한자: <strong lang="zh-Hani">{{ selected.char }}</strong> ({{ selected.reading ?? '독음 미등록' }} · {{ selected.unicode }}) · 궁서체 윤곽 {{ fontContourCount }}개
          </p>
        </div>
        <div class="ollama-conn-wrap">
          <span class="ollama-conn-badge" :class="status?.connected ? 'is-ok' : 'is-off'">
            <span class="ollama-dot" aria-hidden="true" />
            {{ checking ? '확인 중…' : status?.connected ? '연결됨' : '미연결' }}
          </span>
          <button
            type="button"
            class="ollama-refresh-btn"
            :disabled="checking"
            title="로컬 Ollama 연결 다시 확인"
            @click="refreshStatus"
          >
            새로고침
          </button>
        </div>
      </div>

      <p v-if="status && !status.connected" class="ollama-warn">
        {{ status.error || '로컬 Ollama 서버(127.0.0.1:11434)가 꺼져 있습니다.' }}
        터미널에서 <code>ollama serve</code>를 실행한 뒤 새로고침하세요.
      </p>

      <p v-if="selected && fontContourCount === 0" class="ollama-warn">
        현재 한자에 궁서체(현재 기준) 윤곽이 없어 분리할 수 없습니다.
      </p>

      <fieldset class="ollama-fieldset">
        <legend class="ollama-field-label">기준 획순 소스</legend>
        <div class="source-choice-grid">
          <label class="source-choice-btn" for="ollama-source-naver">
            <input
              id="ollama-source-naver"
              v-model="selectedSource"
              type="radio"
              name="ollama-split-source"
              value="NAVER"
              class="visually-hidden"
            />
            <strong>네이버 (NAVER)</strong>
            <span>{{ naverStrokeCount > 0 ? `${naverStrokeCount}획 준비됨` : '실행 시 자동 수신' }}</span>
          </label>
          <label class="source-choice-btn" for="ollama-source-mmh">
            <input
              id="ollama-source-mmh"
              v-model="selectedSource"
              type="radio"
              name="ollama-split-source"
              value="MMH"
              class="visually-hidden"
            />
            <strong>Hanzi (MMH)</strong>
            <span>{{ mmhStrokeCount > 0 ? `${mmhStrokeCount}획 준비됨` : '실행 시 자동 수신' }}</span>
          </label>
        </div>
      </fieldset>

      <div class="ollama-field">
        <label for="ollama-split-model">로컬 모델</label>
        <div class="ollama-row">
          <select
            id="ollama-split-model"
            v-model="selectedModel"
            name="model"
            autofocus
            :disabled="checking"
          >
            <option v-for="modelName in availableModels" :key="modelName" :value="modelName">
              {{ modelName }}
            </option>
          </select>
        </div>
      </div>

      <p v-if="statusError" class="error" role="alert">{{ statusError }}</p>

      <form method="dialog" class="dialog-actions">
        <button type="submit" value="cancel">닫기</button>
        <button
          type="button"
          class="primary"
          :disabled="!selected || fontContourCount === 0 || !status?.connected || busy"
          @click="submitSplit"
        >
          궁서체 획 분리 실행
        </button>
      </form>
    </div>
  </dialog>
</template>
