<script setup lang="ts">
import { ref } from 'vue'
import { IMAGE_MIMES, type ImageSplit } from '../../shared/constants.ts'
import { ISSUE_LABELS } from '../lib/labels.ts'
import type { TransformMode } from '../lib/transformMath.ts'
import type { CharacterDetail, EditorTool, KnifeMode, LayerRecord, Pt } from '../../shared/types.ts'
import ConnectToolOptions from './toolOptions/ConnectToolOptions.vue'
import KnifeToolOptions from './toolOptions/KnifeToolOptions.vue'
import MedianToolOptions from './toolOptions/MedianToolOptions.vue'
import SelectToolOptions from './toolOptions/SelectToolOptions.vue'

defineProps<{
  selected: CharacterDetail | null
  tool: EditorTool
  scope: 'layer' | 'stroke'
  transformMode: TransformMode
  editableLayer: LayerRecord | null
  locked: boolean
  hasFont: boolean
  knifePoints: Pt[]
  knifeMode: KnifeMode
  connectPoints: Pt[]
  dirtyCount: number
  workStrokeCount: number
  busy: boolean
}>()

const emit = defineEmits<{
  changeScope: [scope: 'layer' | 'stroke']
  changeTransformMode: [mode: TransformMode]
  changeKnifeMode: [mode: KnifeMode]
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
  importImage: [event: Event, split: ImageSplit]
  sync: []
}>()

const menuRef = ref<HTMLDetailsElement | null>(null)
const svgFileInput = ref<HTMLInputElement | null>(null)
const imageFileInput = ref<HTMLInputElement | null>(null)
// 이미지 파일을 고르기 전에 정한 획 나누기 방식. 파일 선택 창이 닫힌 뒤 change 이벤트와 함께 보낸다.
const imageSplit = ref<ImageSplit>('AUTO')

function pickImage(split: ImageSplit) {
  imageSplit.value = split
  imageFileInput.value?.click()
}

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

      <SelectToolOptions
        v-if="tool === 'select'"
        :scope="scope"
        :transform-mode="transformMode"
        :editable-layer="editableLayer"
        :locked="locked"
        :has-font="hasFont"
        :busy="busy"
        @change-scope="emit('changeScope', $event)"
        @change-transform-mode="emit('changeTransformMode', $event)"
        @align-font="emit('alignFont')"
        @auto-fit="emit('autoFit')"
      />
      <MedianToolOptions
        v-else-if="tool === 'median'"
        :editable-layer="editableLayer"
        :locked="locked"
        :has-font="hasFont"
        :busy="busy"
        @reverse-median="emit('reverseMedian')"
        @resegment="emit('resegment')"
      />
      <ConnectToolOptions
        v-else-if="tool === 'connect'"
        :connect-points="connectPoints"
        :locked="locked"
        :busy="busy"
        @cancel-connect="emit('cancelConnect')"
        @undo-connect="emit('undoConnect')"
        @commit-connect="emit('commitConnect')"
      />
      <KnifeToolOptions
        v-else-if="tool === 'knife'"
        :knife-points="knifePoints"
        :knife-mode="knifeMode"
        @change-knife-mode="emit('changeKnifeMode', $event)"
        @cancel-knife="emit('cancelKnife')"
      />

      <template v-else-if="tool === 'bezier'">
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
      <input
        ref="imageFileInput"
        class="visually-hidden"
        tabindex="-1"
        aria-hidden="true"
        type="file"
        :accept="IMAGE_MIMES.join(',')"
        @change="emit('importImage', $event, imageSplit)"
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
          <button
            type="button"
            role="menuitem"
            :disabled="!selected || busy"
            title="PNG·JPEG·WebP 글자 이미지를 윤곽으로 추적하고, 기존 중심선이 있으면 그것으로 획을 나눕니다"
            @click="runMenuAction(() => pickImage('AUTO'))"
          >
            이미지를 획 SVG로 변환…
          </button>
          <button
            type="button"
            role="menuitem"
            :disabled="!selected || busy"
            title="이어진 덩어리 하나를 획 하나로 봅니다(기존 중심선을 쓰지 않음)"
            @click="runMenuAction(() => pickImage('COMPONENTS'))"
          >
            이미지를 획 SVG로 변환 (덩어리=획)…
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
