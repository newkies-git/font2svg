<script setup lang="ts">
import { LAYER_ID } from '../../shared/constants.ts'
import { ref } from 'vue'
import { ISSUE_LABELS } from '../lib/labels.ts'
import type { TransformMode } from '../lib/transformMath.ts'
import type { CharacterDetail, EditorTool, LayerRecord, Pt } from '../../shared/types.ts'

defineProps<{
  selected: CharacterDetail | null
  tool: EditorTool
  scope: 'layer' | 'stroke'
  transformMode: TransformMode
  editableLayer: LayerRecord | null
  locked: boolean
  hasFont: boolean
  knifeFrom: Pt | null
  connectPoints: Pt[]
  dirtyCount: number
  workStrokeCount: number
  busy: boolean
}>()

const TRANSFORM_MODES: { mode: TransformMode; label: string; hint: string }[] = [
  { mode: 'scale', label: '크기', hint: '8방향 핸들로 크기를 조절합니다 (Shift: 비율 유지)' },
  { mode: 'rotate', label: '회전', hint: '모서리 핸들을 끌어 중심을 기준으로 회전합니다 (Shift: 15° 단위)' },
  { mode: 'skew', label: '기울임', hint: '변 중앙 핸들을 끌어 반대편 변을 고정한 채 기울입니다' },
  { mode: 'distort', label: '왜곡', hint: '모서리 하나만 옮겨 사다리꼴·비틀림 모양으로 맞춥니다' },
]

const emit = defineEmits<{
  changeScope: [scope: 'layer' | 'stroke']
  changeTransformMode: [mode: TransformMode]
  alignFont: []
  autoFit: []
  reverseMedian: []
  resegment: []
  cancelKnife: []
  cancelConnect: []
  undoConnect: []
  commitConnect: []
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
        <div class="seg-control" role="group" aria-label="변형 방식">
          <button
            v-for="m in TRANSFORM_MODES"
            :key="m.mode"
            type="button"
            :class="{ on: transformMode === m.mode }"
            :aria-pressed="transformMode === m.mode"
            :title="m.hint"
            @click="emit('changeTransformMode', m.mode)"
          >
            {{ m.label }}
          </button>
        </div>
        <button
          v-if="hasFont && editableLayer && editableLayer.id !== LAYER_ID.font"
          type="button"
          class="bar-btn"
          :disabled="locked || busy"
          title="활성 레이어의 바운딩 박스를 궁서체(TTF) 윤곽 영역에 정렬합니다"
          @click="emit('alignFont')"
        >
          궁서체 맞춤
        </button>
        <button
          v-if="hasFont && editableLayer && editableLayer.id !== LAYER_ID.font"
          type="button"
          class="bar-btn"
          :disabled="locked || busy"
          :title="scope === 'stroke'
            ? '선택한 획을 그 획이 맡은 궁서체 영역에 겹침이 최대가 되도록 자동으로 맞춥니다'
            : '레이어 전체를 궁서체 글자에 겹침이 최대가 되도록 맞추고, 획마다 한 번 더 보정합니다'"
          @click="emit('autoFit')"
        >
          자동 맞춤
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
          title="현재 중심선을 기준으로 궁서체 윤곽을 다시 획별로 분할합니다. 정밀 지정 시 캔버스 돋보기를 활용하세요."
          @click="emit('resegment')"
        >
          윤곽 재분할
        </button>
        <span class="knife-inline-pill" role="status" title="중심선·베지어·칼·윤곽연결 도구에서 커서 주변을 확대합니다">돋보기 ON</span>
      </template>

      <template v-else-if="tool === 'connect'">
        <span class="knife-inline-pill" role="status">
          <template v-if="connectPoints.length === 0">시작점 클릭</template>
          <template v-else>{{ connectPoints.length }}점 — Enter 연결</template>
        </span>
        <button
          type="button"
          class="bar-btn"
          :disabled="locked || busy || connectPoints.length < 3"
          title="지정한 시작·중간·끝점으로 닫힌 윤곽을 만듭니다 (Enter)"
          @click="emit('commitConnect')"
        >
          윤곽 연결
        </button>
        <button
          type="button"
          class="bar-btn"
          :disabled="connectPoints.length === 0"
          title="마지막 점 되돌리기 (⌫)"
          @click="emit('undoConnect')"
        >
          점 되돌리기
        </button>
        <button
          v-if="connectPoints.length"
          type="button"
          class="bar-btn"
          @click="emit('cancelConnect')"
        >
          취소 (Esc)
        </button>
      </template>

      <template v-else-if="tool === 'knife' && knifeFrom">
        <span class="knife-inline-pill" role="status">분할 시작점 지정됨 — 끝점 클릭</span>
        <button type="button" class="bar-btn" @click="emit('cancelKnife')">취소 (Esc)</button>
      </template>

      <template v-else-if="tool === 'bezier' || tool === 'knife'">
        <span class="knife-inline-pill" role="status" title="정밀 편집 시 커서 주변을 확대합니다">돋보기 ON</span>
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
