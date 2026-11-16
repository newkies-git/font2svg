<script setup lang="ts">
import type { CharacterSummary } from '../../shared/types.ts'

defineProps<{
  rows: CharacterSummary[]
  total: number
  query: string
  selectedUnicode?: string
}>()
const emit = defineEmits<{ open: [row: CharacterSummary]; upload: [event: Event] }>()
</script>

<template>
  <nav class="chars" aria-label="한자 목록">
    <div v-if="!query && total === 0" class="upload-box">
      <label for="initial-file-upload" class="empty">
        등록된 한자가 없습니다. 한자 목록 JSON 파일을 업로드하세요.
      </label>
      <input
        id="initial-file-upload"
        type="file"
        accept="application/json,.json"
        @change="emit('upload', $event)"
      />
    </div>
    <div v-else-if="rows.length === 0" class="empty-filter">
      <p>해당 조건의 한자가 없습니다.</p>
    </div>
    <ul v-else class="char-list" role="list">
      <li v-for="row in rows" :key="row.unicode">
        <button
          class="char"
          :class="{ active: selectedUnicode === row.unicode }"
          :aria-current="selectedUnicode === row.unicode ? 'true' : undefined"
          @click="emit('open', row)"
        >
          <span class="glyph" lang="zh-Hani">{{ row.char }}</span>
          <div class="meta">
            <span class="meta-title">{{ row.reading ?? '독음 미등록' }}</span>
            <span class="meta-sub">{{ row.unicode }} · {{ row.stroke_count }}획</span>
          </div>
          <div class="char-badges">
            <span
              v-if="row.issue_status"
              class="status-tag"
              :class="`tag-${row.issue_status.toLowerCase()}`"
            >
              {{ row.issue_status === 'APPROVED' ? '승인' : row.issue_status === 'DRAFT' ? '대기' : '작업전' }}
            </span>
            <span v-if="row.in_font" class="font-tag" title="궁서체 포함">궁서</span>
          </div>
        </button>
      </li>
    </ul>
  </nav>
</template>
