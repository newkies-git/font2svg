<script setup lang="ts">
import type { EditorTool } from '../types.ts'

defineProps<{ tool: EditorTool }>()
const emit = defineEmits<{ select: [tool: EditorTool] }>()

const tools: { id: EditorTool; key: string; label: string; tip: string }[] = [
  { id: 'select', key: 'V', label: '선택·변환', tip: '선택 및 이동·크기 변환 (V)' },
  { id: 'bezier', key: 'A', label: '베지어 정점', tip: '베지어 앵커·곡선 제어점 편집 (A)' },
  { id: 'median', key: 'M', label: '중심선 편집', tip: '중심선 정점 이동·추가·삭제 · 윤곽 재분할 (M)' },
  { id: 'connect', key: 'P', label: '윤곽 연결', tip: '시작·중간·끝점을 찍어 윤곽을 다시 연결 (P)' },
  { id: 'knife', key: 'K', label: '칼 분할', tip: '외곽선 칼 분할 (K)' },
]
</script>

<template>
  <aside class="tool-rail" role="toolbar" aria-orientation="vertical" aria-label="벡터 편집 도구">
    <button
      v-for="item in tools"
      :key="item.id"
      type="button"
      class="rail-btn"
      :class="{ active: tool === item.id }"
      :aria-pressed="tool === item.id"
      :aria-label="`${item.label} (${item.key})`"
      :title="item.tip"
      @click="emit('select', item.id)"
    >
      <!-- Select / Move Icon -->
      <svg v-if="item.id === 'select'" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M4 2.5L14.5 9.2L9.6 10.3L7.5 15L4 2.5Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
      </svg>
      <!-- Direct Selection / Bezier Node Icon -->
      <svg v-else-if="item.id === 'bezier'" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M3 14C3 8 8 4 15 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
        <rect x="6.5" y="4.5" width="4.5" height="4.5" fill="var(--color-bg-surface)" stroke="currentColor" stroke-width="1.5" />
        <circle cx="3" cy="14" r="2" fill="currentColor" />
        <circle cx="15" cy="4" r="2" fill="currentColor" />
      </svg>
      <!-- Median Spline Icon -->
      <svg v-else-if="item.id === 'median'" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M3 13.5L7.5 7.5L11 10.5L15 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        <circle cx="3" cy="13.5" r="2" fill="currentColor" />
        <circle cx="7.5" cy="7.5" r="1.8" fill="currentColor" />
        <circle cx="15" cy="4.5" r="2" fill="currentColor" />
      </svg>
      <!-- Outline Connect Icon -->
      <svg v-else-if="item.id === 'connect'" viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M3 14L6.5 7.5L11 11L15 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M15 4L15 14L3 14" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="2.5 2" opacity="0.7" />
        <circle cx="3" cy="14" r="2" fill="currentColor" />
        <circle cx="6.5" cy="7.5" r="1.6" fill="currentColor" />
        <circle cx="11" cy="11" r="1.6" fill="currentColor" />
        <circle cx="15" cy="4" r="2" fill="currentColor" />
      </svg>
      <!-- Knife Cut Icon -->
      <svg v-else viewBox="0 0 18 18" fill="none" aria-hidden="true">
        <path d="M3.5 14.5L14.5 3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        <path d="M10.5 3.5H14.5V7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        <path d="M3.5 10.5L7.5 14.5" stroke="currentColor" stroke-width="1.4" stroke-dasharray="2 2" stroke-linecap="round" />
      </svg>
      <span class="rail-key" aria-hidden="true">{{ item.key }}</span>
    </button>
  </aside>
</template>
