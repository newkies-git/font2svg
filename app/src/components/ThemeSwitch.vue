<script setup lang="ts">
import type { ThemeMode } from '../types.ts'

defineProps<{ mode: ThemeMode }>()
const emit = defineEmits<{ select: [mode: ThemeMode] }>()
</script>

<template>
  <div class="theme-switch" role="group" aria-label="화면 테마">
    <button
      type="button"
      class="theme-btn"
      :class="{ active: mode === 'system' }"
      :aria-pressed="mode === 'system'"
      title="시스템 테마"
      @click="emit('select', 'system')"
    >
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="3" width="12" height="8.5" rx="1.2" stroke="currentColor" stroke-width="1.4" />
        <path d="M5.5 14h5M8 11.5V14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
      <span class="visually-hidden">시스템 테마</span>
    </button>
    <button
      type="button"
      class="theme-btn"
      :class="{ active: mode === 'light' }"
      :aria-pressed="mode === 'light'"
      title="라이트 모드"
      @click="emit('select', 'light')"
    >
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="8" cy="8" r="3" stroke="currentColor" stroke-width="1.4" />
        <path d="M8 1.8v1.5M8 12.7v1.5M1.8 8h1.5M12.7 8h1.5M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
      <span class="visually-hidden">라이트 모드</span>
    </button>
    <button
      type="button"
      class="theme-btn"
      :class="{ active: mode === 'dark' }"
      :aria-pressed="mode === 'dark'"
      title="다크 모드"
      @click="emit('select', 'dark')"
    >
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M13.2 9.8A5.5 5.5 0 0 1 6.2 2.8a5.5 5.5 0 1 0 7 7Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" />
      </svg>
      <span class="visually-hidden">다크 모드</span>
    </button>
  </div>
</template>
