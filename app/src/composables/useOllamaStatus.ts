import { computed, ref } from 'vue'
import type { OllamaStatus } from '../../shared/types.ts'
import { fetchOllamaStatus } from '../lib/api.ts'

const DEFAULT_OLLAMA_FALLBACK = 'qwen3.5:9b'

const status = ref<OllamaStatus | null>(null)
const checking = ref(false)
const selectedModel = ref('')
const statusError = ref('')

const availableModels = computed(() => {
  const list = status.value?.models ?? []
  const fallback = status.value?.defaultModel || DEFAULT_OLLAMA_FALLBACK
  return list.length > 0 ? list : [fallback]
})

const activeModelLabel = computed(() => {
  if (!status.value?.connected) return '꺼짐'
  return selectedModel.value || status.value.defaultModel || DEFAULT_OLLAMA_FALLBACK
})

async function refreshStatus() {
  checking.value = true
  statusError.value = ''
  try {
    const res = await fetchOllamaStatus()
    status.value = res
    if (!selectedModel.value || (res.models.length > 0 && !res.models.includes(selectedModel.value))) {
      selectedModel.value = res.defaultModel
    }
  } catch (cause) {
    statusError.value = cause instanceof Error ? cause.message : 'Ollama 상태를 확인하지 못했습니다.'
  } finally {
    checking.value = false
  }
}

export function useOllamaStatus() {
  return {
    status,
    checking,
    selectedModel,
    availableModels,
    activeModelLabel,
    statusError,
    refreshStatus,
  }
}
