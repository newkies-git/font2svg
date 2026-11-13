<script setup lang="ts">
defineProps<{
  hasSelection: boolean
  shown: number
  total: number
  playing: boolean
}>()
const emit = defineEmits<{ first: []; prev: []; next: []; all: []; togglePlay: [] }>()
</script>

<template>
  <div class="transport-bar" role="toolbar" aria-label="필순 재생 및 단계 탐색">
    <div class="transport-group">
      <button type="button" class="transport-btn" :disabled="!hasSelection || shown <= 1" title="첫 획" @click="emit('first')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 3.5v9M11.5 3.5L6.5 8l5 4.5V3.5Z" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>처음</span>
      </button>
      <button type="button" class="transport-btn" :disabled="!hasSelection || shown <= 1" title="이전 획 (←)" @click="emit('prev')">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M10 3.5L5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span>이전</span>
      </button>

      <div class="step-counter" aria-live="polite" aria-atomic="true">
        <span class="step-current">{{ shown }}</span>
        <span class="step-divider">/</span>
        <span class="step-total">{{ total }}</span>
        <span class="step-unit">획</span>
      </div>

      <button type="button" class="transport-btn" :disabled="!hasSelection || shown >= total" title="다음 획 (→)" @click="emit('next')">
        <span>다음</span>
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button type="button" class="transport-btn" :disabled="!hasSelection" title="전체 획 표시" @click="emit('all')">
        <span>전체</span>
      </button>
    </div>

    <button
      type="button"
      class="primary transport-play-btn"
      :disabled="!hasSelection"
      :title="playing ? '일시정지 (Space)' : '필순 재생 (Space)'"
      @click="emit('togglePlay')"
    >
      <svg v-if="playing" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="4.5" y="3.5" width="2.5" height="9" rx="0.6" fill="currentColor" />
        <rect x="9" y="3.5" width="2.5" height="9" rx="0.6" fill="currentColor" />
      </svg>
      <svg v-else viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M5 3.2L12.5 8 5 12.8V3.2Z" fill="currentColor" />
      </svg>
      <span>{{ playing ? '정지' : '재생' }}</span>
    </button>
  </div>
</template>
