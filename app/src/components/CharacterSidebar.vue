<script setup lang="ts">
import type { CharacterSummary, StatusFilter, ThemeMode } from '../types.ts'
import CharacterList from './CharacterList.vue'
import ThemeSwitch from './ThemeSwitch.vue'

defineProps<{
  themeMode: ThemeMode
  counts: Record<StatusFilter, number>
  rows: CharacterSummary[]
  total: number
  selectedUnicode?: string
}>()
const emit = defineEmits<{
  selectTheme: [mode: ThemeMode]
  search: []
  submit: []
  clearSearch: []
  open: [row: CharacterSummary]
  upload: [event: Event]
}>()
const query = defineModel<string>('query', { required: true })
const statusFilter = defineModel<StatusFilter>('statusFilter', { required: true })

const tabs: { filter: StatusFilter; label: string; countClass?: string }[] = [
  { filter: 'ALL', label: '전체' },
  { filter: 'APPROVED', label: '승인', countClass: 'count-approved' },
  { filter: 'DRAFT', label: '대기', countClass: 'count-draft' },
  { filter: 'OPEN', label: '미착수', countClass: 'count-open' },
]

function onSearchKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    if (event.isComposing || event.keyCode === 229) return
    event.preventDefault()
    emit('submit')
  }
}
</script>

<template>
  <aside class="side" aria-label="한자 탐색">
    <header class="side-header">
      <div class="brand-row">
        <div class="brand-title">
          <h1>추사 1817</h1>
          <span class="brand-sub">Stroke Studio</span>
        </div>
        <ThemeSwitch :mode="themeMode" @select="emit('selectTheme', $event)" />
      </div>

      <div class="search-box">
        <label for="char-search" class="visually-hidden">한자, 독음, 유니코드 검색</label>
        <div class="search-input-wrap">
          <svg class="search-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.5" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
          <input
            id="char-search"
            v-model="query"
            type="search"
            class="search"
            placeholder="한자 · 독음 · U+코드"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            enterkeyhint="search"
            @input="emit('search')"
            @keydown="onSearchKeyDown"
          />
          <button
            v-if="query"
            type="button"
            class="search-clear-btn"
            aria-label="검색어 지우기"
            @click="emit('clearSearch')"
          >
            ✕
          </button>
        </div>
      </div>

      <div class="filter-tabs" role="tablist" aria-label="상태별 필터">
        <button
          v-for="tab in tabs"
          :key="tab.filter"
          type="button"
          role="tab"
          class="tab-btn"
          :class="{ active: statusFilter === tab.filter }"
          :aria-selected="statusFilter === tab.filter"
          @click="statusFilter = tab.filter"
        >
          <span>{{ tab.label }}</span>
          <span class="tab-count" :class="tab.countClass">{{ counts[tab.filter] }}</span>
        </button>
      </div>
    </header>

    <CharacterList
      :rows="rows"
      :total="total"
      :query="query"
      :selected-unicode="selectedUnicode"
      @open="emit('open', $event)"
      @upload="emit('upload', $event)"
    />
  </aside>
</template>
