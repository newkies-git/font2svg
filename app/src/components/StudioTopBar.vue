<script setup lang="ts">
import { ref } from 'vue'
import { ISSUE_LABELS } from '../lib/labels.ts'
import type { CharacterDetail, EditorTool, LayerRecord, Pt } from '../types.ts'

defineProps<{
  selected: CharacterDetail | null
  tool: EditorTool
  scope: 'layer' | 'stroke'
  editableLayer: LayerRecord | null
  locked: boolean
  hasFont: boolean
  knifeFrom: Pt | null
  dirtyCount: number
  workStrokeCount: number
  busy: boolean
}>()

const emit = defineEmits<{
  changeScope: [scope: 'layer' | 'stroke']
  alignFont: []
  reverseMedian: []
  resegment: []
  cancelKnife: []
  unlock: []
  save: []
  approve: []
  undo: []
  compile: []
  naver: []
  reference: []
  importSvg: [event: Event]
  sync: []
}>()

const menuRef = ref<HTMLDetailsElement | null>(null)
const svgFileInput = ref<HTMLInputElement | null>(null)

function closeMenu() {
  if (menuRef.value) menuRef.value.open = false
}

function runMenuAction(fn: () => void) {
  closeMenu()
  fn()
}
</script>

<template>
  <header class="studio-topbar" role="region" aria-label="문서 및 도구 옵션 바">
    <!-- 좌측: 현재 글자 정보 -->
    <div class="topbar-doc">
      <template v-if="selected">
        <span class="doc-glyph" lang="zh-Hani">{{ selected.char }}</span>
        <div class="doc-title-group">
          <strong class="doc-reading">{{ selected.reading ?? '독음 미등록' }}</strong>
          <span v-if="selected.meaning" class="doc-meaning">{{ selected.meaning }}</span>
          <code class="doc-code">{{ selected.unicode }}</code>
        </div>
        <div class="doc-badges">
          <span class="doc-tag">{{ workStrokeCount }}획</span>
          <span v-if="selected.grade" class="doc-tag">{{ selected.grade }}</span>
          <span v-if="selected.origin" class="doc-tag tag-origin">{{ selected.origin }}</span>
          <span
            v-if="selected.issue_status"
            class="status-tag"
            :class="`tag-${selected.issue_status.toLowerCase()}`"
          >
            {{ ISSUE_LABELS[selected.issue_status] }}
          </span>
        </div>
      </template>
      <span v-else class="doc-placeholder">편집할 한자를 좌측에서 선택하세요</span>
    </div>

    <!-- 중앙: 선택된 도구 전용 컨텍스트 옵션 -->
    <div v-if="selected" class="topbar-options" role="toolbar" aria-label="활성 도구 옵션">
      <button
        v-if="locked"
        type="button"
        class="ctx-unlock-chip"
        title="현재 편집 대상 레이어가 잠겨 있거나 숨겨져 있습니다. 클릭하여 잠금을 해제합니다."
        @click="emit('unlock')"
      >
        잠금 해제
      </button>

      <template v-if="tool === 'select'">
        <div class="seg-control" role="group" aria-label="변환 대상 범위">
          <button
            type="button"
            :class="{ on: scope === 'layer' }"
            :aria-pressed="scope === 'layer'"
            @click="emit('changeScope', 'layer')"
          >
            전체 변환
          </button>
          <button
            type="button"
            :class="{ on: scope === 'stroke' }"
            :aria-pressed="scope === 'stroke'"
            @click="emit('changeScope', 'stroke')"
          >
            단일 획 변환
          </button>
        </div>
        <button
          v-if="hasFont && editableLayer && editableLayer.id !== 'font'"
          type="button"
          class="bar-btn"
          :disabled="locked || busy"
          title="활성 레이어의 바운딩 박스를 궁서체(TTF) 윤곽 영역에 정렬합니다"
          @click="emit('alignFont')"
        >
          궁서체 맞춤
        </button>
      </template>

      <template v-else-if="tool === 'median'">
        <button
          type="button"
          class="bar-btn"
          :disabled="locked || busy || !editableLayer?.strokes.length"
          title="선택 획의 기필(시작점)과 수필(끝점) 방향을 반전합니다"
          @click="emit('reverseMedian')"
        >
          기필↔수필 반전
        </button>
        <button
          v-if="hasFont"
          type="button"
          class="bar-btn"
          :disabled="locked || busy || !editableLayer?.strokes.length"
          title="현재 중심선을 기준으로 궁서체 윤곽을 다시 획별로 분할합니다"
          @click="emit('resegment')"
        >
          윤곽 재분할
        </button>
      </template>

      <template v-else-if="tool === 'knife' && knifeFrom">
        <span class="knife-inline-pill" role="status">분할 시작점 지정됨 — 끝점 클릭</span>
        <button type="button" class="bar-btn" @click="emit('cancelKnife')">취소 (Esc)</button>
      </template>
    </div>

    <!-- 우측: 단일 통합 문서 작업 바 -->
    <div class="topbar-actions" role="toolbar" aria-label="문서 저장 및 내보내기">
      <button
        type="button"
        class="bar-btn"
        :disabled="!selected || busy || !selected.history_count"
        :title="selected?.history_count ? `실행 취소 (이력 ${selected.history_count}회 · ⌘Z)` : '이전 편집 이력이 없습니다'"
        @click="emit('undo')"
      >
        실행 취소<span v-if="selected?.history_count" class="btn-count">{{ selected.history_count }}</span>
      </button>

      <button
        type="button"
        class="bar-btn primary"
        :disabled="!selected || busy"
        title="변경된 레이어 저장 (⌘S)"
        @click="emit('save')"
      >
        저장<span v-if="dirtyCount > 0" class="dirty-badge">{{ dirtyCount }}</span>
      </button>

      <button
        v-if="selected?.working"
        type="button"
        class="bar-btn success-btn"
        :disabled="workStrokeCount === 0 || busy"
        title="초안 작업 데이터를 최종 획(strokes)으로 승인합니다"
        @click="emit('approve')"
      >
        승인
      </button>

      <button
        type="button"
        class="bar-btn"
        :disabled="!selected || busy || selected.working"
        title="배포용 컴파일 JSON 및 애니메이션 SVG 생성"
        @click="emit('compile')"
      >
        컴파일
      </button>

      <input
        ref="svgFileInput"
        class="visually-hidden"
        tabindex="-1"
        aria-hidden="true"
        type="file"
        accept="image/svg+xml,.svg"
        @change="emit('importSvg', $event)"
      />

      <details ref="menuRef" class="more-menu">
        <summary class="bar-btn more-summary" aria-label="데이터 동기화 및 가져오기 메뉴">
          데이터 ▾
        </summary>
        <div class="more-popover" role="menu">
          <button
            type="button"
            role="menuitem"
            :disabled="!selected || busy"
            @click="runMenuAction(() => emit('naver'))"
          >
            네이버 획순으로 작업 획 교체…
          </button>
          <button
            type="button"
            role="menuitem"
            :disabled="!selected || busy"
            @click="runMenuAction(() => emit('reference'))"
          >
            레퍼런스 다시 수신
          </button>
          <button
            type="button"
            role="menuitem"
            :disabled="!selected || busy || (workStrokeCount > 0 && !selected.working)"
            @click="runMenuAction(() => svgFileInput?.click())"
          >
            AnimCJK SVG 파일 가져오기…
          </button>
          <hr />
          <button
            type="button"
            role="menuitem"
            :disabled="busy"
            @click="runMenuAction(() => emit('sync'))"
          >
            미완료 20자 일괄 동기화
          </button>
        </div>
      </details>
    </div>
  </header>
</template>
