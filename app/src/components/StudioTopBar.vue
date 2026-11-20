<script setup lang="ts">
import { ref } from 'vue'
import { IMAGE_MIMES, type ImageSplit } from '../../shared/constants.ts'
import { isReferenceKind } from '../../shared/layerKind.ts'
import { ISSUE_LABELS } from '../lib/labels.ts'
import type { TransformMode } from '../lib/transformMath.ts'
import type { CharacterDetail, EditorTool, KnifeMode, LayerRecord, Pt } from '../../shared/types.ts'
import { formatLoupeZoom, isLoupeTool, useLoupeControls } from '../composables/useCanvasLoupe.ts'
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
  layerDirty: boolean
  workStrokeCount: number
  busy: boolean
  selectedPathPointCount: number
  canEditPathPoints: boolean
  canDeletePathPoints: boolean
}>()

const emit = defineEmits<{
  changeScope: [scope: 'layer' | 'stroke']
  changeTransformMode: [mode: TransformMode]
  selectTool: [tool: EditorTool]
  changeKnifeMode: [mode: KnifeMode]
  autoFit: []
  resetEdits: []
  insertPathPoint: []
  togglePathCurve: []
  simplifyPathPoints: []
  deletePathPoints: []
  clearPathPoints: []
  reverseMedian: []
  resegment: []
  cancelKnife: []
  cancelConnect: []
  undoConnect: []
  commitConnect: []
  commitBridge: []
  unlock: []
  save: []
  approve: []
  undo: []
  compile: []
  naver: []
  conversions: []
  importSvg: [event: Event]
  importImage: [event: Event, split: ImageSplit]
}>()

const { loupeOn, loupeZoom, canZoomOut, canZoomIn, toggleLoupe, stepLoupeZoom } = useLoupeControls()
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
      <span
        v-if="locked && editableLayer && isReferenceKind(editableLayer.kind)"
        class="ctx-unlock-chip"
        title="네이버·AnimCJK·Hanzi는 작업 획으로 가져온 뒤 편집합니다."
      >
        참고 전용
      </span>
      <button
        v-else-if="locked"
        type="button"
        class="ctx-unlock-chip"
        title="현재 편집 대상 레이어가 잠겨 있거나 숨겨져 있습니다. 클릭하여 잠금을 해제합니다."
        @click="emit('unlock')"
      >
        잠금 해제
      </button>

      <SelectToolOptions
        v-if="tool === 'select' || tool === 'bezier'"
        :tool="tool"
        :scope="scope"
        :transform-mode="transformMode"
        :editable-layer="editableLayer"
        :locked="locked"
        :has-font="hasFont"
        :dirty="layerDirty"
        :busy="busy"
        :selected-path-point-count="selectedPathPointCount"
        :can-edit-path-points="canEditPathPoints"
        :can-delete-path-points="canDeletePathPoints"
        @change-scope="emit('changeScope', $event)"
        @change-transform-mode="emit('changeTransformMode', $event)"
        @select-tool="emit('selectTool', $event)"
        @auto-fit="emit('autoFit')"
        @reset-edits="emit('resetEdits')"
        @insert-path-point="emit('insertPathPoint')"
        @toggle-path-curve="emit('togglePathCurve')"
        @simplify-path-points="emit('simplifyPathPoints')"
        @delete-path-points="emit('deletePathPoints')"
        @clear-path-points="emit('clearPathPoints')"
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
        @commit-bridge="emit('commitBridge')"
      />
      <KnifeToolOptions
        v-else-if="tool === 'knife'"
        :knife-points="knifePoints"
        :knife-mode="knifeMode"
        @change-knife-mode="emit('changeKnifeMode', $event)"
        @cancel-knife="emit('cancelKnife')"
      />

      <div v-if="isLoupeTool(tool)" class="loupe-control" role="group" aria-label="돋보기 설정">
        <button
          type="button"
          class="bar-btn"
          :class="{ on: loupeOn }"
          :aria-pressed="loupeOn"
          title="커서 옆을 확대합니다(Alt+휠로 배율 조절). 렌즈는 커서를 가리지 않습니다."
          @click="toggleLoupe"
        >
          돋보기 {{ loupeOn ? `${formatLoupeZoom(loupeZoom)}×` : '꺼짐' }}
        </button>
        <template v-if="loupeOn">
          <button
            type="button"
            class="bar-btn loupe-step-btn"
            :disabled="!canZoomOut"
            aria-label="돋보기 축소"
            title="돋보기 배율 줄이기"
            @click="stepLoupeZoom(1)"
          >
            −
          </button>
          <button
            type="button"
            class="bar-btn loupe-step-btn"
            :disabled="!canZoomIn"
            aria-label="돋보기 확대"
            title="돋보기 배율 키우기"
            @click="stepLoupeZoom(-1)"
          >
            +
          </button>
        </template>
      </div>
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
            네이버 획순을 작업 획으로…
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
            :disabled="!selected || busy"
            title="현재 한자의 이미지 → 획 SVG 변환 기록을 봅니다"
            @click="runMenuAction(() => emit('conversions'))"
          >
            이미지 변환 이력 보기…
          </button>
        </div>
      </details>
    </div>
  </header>
</template>
