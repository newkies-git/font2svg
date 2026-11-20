<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import CharacterSidebar from './components/CharacterSidebar.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import ConversionsDialog from './components/ConversionsDialog.vue'
import ImportChoiceDialog from './components/ImportChoiceDialog.vue'
import LayerCanvas from './components/LayerCanvas.vue'
import LayersPanel from './components/LayersPanel.vue'
import OllamaIdsDialog from './components/OllamaIdsDialog.vue'
import OllamaSplitDialog from './components/OllamaSplitDialog.vue'
import StepControls from './components/StepControls.vue'
import StrokeList from './components/StrokeList.vue'
import StudioTopBar from './components/StudioTopBar.vue'
import ToolRail from './components/ToolRail.vue'
import { useCharacterActions } from './composables/useCharacterActions.ts'
import { useCharacterList } from './composables/useCharacterList.ts'
import { useLayerWorkspace } from './composables/useLayerWorkspace.ts'
import { useOllamaStatus } from './composables/useOllamaStatus.ts'
import { usePlayback } from './composables/usePlayback.ts'
import { useStrokeStepper } from './composables/useStrokeStepper.ts'
import { useStudioShortcuts } from './composables/useStudioShortcuts.ts'
import { useStudioState } from './composables/useStudioState.ts'
import { useTheme } from './composables/useTheme.ts'
import { LAYER_ID } from '../shared/constants.ts'
import type { CapType } from '../shared/types.ts'

const studio = useStudioState()
const { selected, message, error, busy, shown, reveal } = studio
const confirmDialog = ref<InstanceType<typeof ConfirmDialog> | null>(null)
const conversionsDialog = ref<InstanceType<typeof ConversionsDialog> | null>(null)
const importChoice = ref<InstanceType<typeof ImportChoiceDialog> | null>(null)
const ollamaDialog = ref<InstanceType<typeof OllamaIdsDialog> | null>(null)
const ollamaSplitDialog = ref<InstanceType<typeof OllamaSplitDialog> | null>(null)
const { status: ollamaStatus, activeModelLabel, refreshStatus: refreshOllamaStatus } = useOllamaStatus()
const confirmImport = () => importChoice.value?.ask() ?? Promise.resolve(undefined)

const { chars, query, statusFilter, filteredChars, statusCounts, loadList, clearSearch } = useCharacterList(error)
const { themeMode, setTheme } = useTheme()

const workStrokeCount = computed(() => {
  const work = layers.value.find((l) => l.id === LAYER_ID.strokes)
  return work ? work.strokes.length : (selected.value?.strokes.length ?? 0)
})

const { playing, play, stop, showAll } = usePlayback(() => workStrokeCount.value, shown, reveal)

const {
  layers,
  panelLayers,
  orderedLayers,
  fontLayer,
  activeLayerId,
  activeTool,
  activeLayer,
  editableLayer,
  isEditableLocked,
  transformScope,
  transformMode,
  selectedStrokeIndex,
  selectedPathPoints,
  knifePoints,
  knifeMode,
  connectPoints,
  dirtyIds,
  syncFromDetail,
  selectLayer,
  selectTool,
  selectStrokeItem,
  toggleLayerVisible,
  soloLayer,
  activeHiddenItems,
  hiddenItemsByLayer,
  toggleStrokeItemVisible,
  setStrokeItemsVisibility,
  setPresetVisibility,
  setLayerOpacity,
  toggleLayerLock,
  setLayerColor,
  renameLayer,
  moveLayerOrder,
  moveStrokeInActive,
  setStrokeRadical,
  setStrokeCap,
  reverseActiveStrokeMedian,
  deleteStrokeAt,
  mergeStrokeWithNext,
  copyStrokeToWorkLayer,
  restoreActiveSnapshot,
  applyAffineToActive,
  autoFitToFont,
  resetActiveEdits,
  updateSinglePathInActive,
  canDeleteSelectedPathPoints,
  setPathPointSelection,
  togglePathPointSelection,
  clearPathPointSelection,
  nudgeSelectedPathPoints,
  insertPathPointAtPos,
  insertPathPointFromSelection,
  toggleSelectedPathCurve,
  simplifySelectedPathPoints,
  deletePathPointAt,
  deleteSelectedPathPoints,
  moveMedianVertex,
  addMedianVertex,
  deleteMedianVertex,
  cancelKnife,
  applyKnifePoint,
  cancelConnect,
  undoConnectPoint,
  applyConnectPoint,
  commitConnectOutline,
  commitConnectBridge,
  saveAllDirtyLayers,
  resetLayerToOriginal,
  fetchReferenceForLayer,
  applyLayerToWorkStrokes,
  resegmentActiveByFont,
  generateOutlineLayer,
  mapOutlineContours,
  refreshOutlineMapping,
  duplicateActiveLayer,
  deleteActiveCustomLayer,
} = useLayerWorkspace(studio, { onReloadList: loadList, stopPlayback: stop, confirmImport })

const { uploadInitial, openChar, openFirst, undo, approve, compileChar, applyNaver, applyOllama, applyOllamaSplit, importSvg, importImage } = useCharacterActions(studio, {
  chars,
  loadList,
  syncFromDetail,
  saveAllDirtyLayers,
  dirtyIds,
  stopPlayback: stop,
  workStrokeCount: () => workStrokeCount.value,
  confirmReplace: () => confirmDialog.value?.ask() ?? Promise.resolve(undefined),
  confirmImport,
  focusWorkStroke: (index) => {
    activeLayerId.value = LAYER_ID.strokes
    activeTool.value = 'select'
    transformScope.value = 'stroke'
    selectStrokeItem(index)
  },
})

// 획 윤곽 자동 매핑에서 중심선 길잡이로 쓸 수 있는 레이어(획이 있는 레이어, 작업 획 우선)
const outlineGuideLayers = computed(() => layers.value
  .filter((l) => l.id !== LAYER_ID.outline && l.strokes.length > 0)
  .sort((a, b) => Number(b.id === LAYER_ID.strokes) - Number(a.id === LAYER_ID.strokes) || a.z_index - b.z_index))

const canEditPathPoints = computed(() => {
  const ed = editableLayer.value
  if (!ed) return false
  return Boolean(ed.kind === 'FONT' ? ed.paths[selectedStrokeIndex.value] : ed.strokes[selectedStrokeIndex.value]?.outline_path)
})

// 기필/수필을 '직접 그리기'로 고르면 꼭짓점(베지어) 편집 도구로 넘어가 그 끝의 윤곽을 손으로 고친다.
function onSetCap(index: number, end: 'start' | 'end', value: CapType) {
  setStrokeCap(index, end, value)
  if (value === 'MANUAL') selectTool('bezier')
}

function unlockActiveLayers() {
  if (activeLayer.value?.locked) toggleLayerLock(activeLayer.value.id)
  if (editableLayer.value?.locked && editableLayer.value.id !== activeLayer.value?.id) {
    toggleLayerLock(editableLayer.value.id)
  }
  if (activeLayer.value && !activeLayer.value.visible) toggleLayerVisible(activeLayer.value.id, false)
  if (editableLayer.value && !editableLayer.value.visible) toggleLayerVisible(editableLayer.value.id, false)
}

const { first: firstStroke, prev: prevStroke, next: nextStroke } = useStrokeStepper(() => workStrokeCount.value, shown, reveal, selectedStrokeIndex)

useStudioShortcuts({
  selected,
  busy,
  activeTool,
  isEditableLocked,
  playing,
  hasKnifePoints: () => knifePoints.value.length > 0,
  hasConnectPoints: () => connectPoints.value.length > 0,
  hasSelectedPathPoints: () => selectedPathPoints.value.size > 0,
  save: () => void saveAllDirtyLayers(),
  undo: () => void undo(),
  selectTool,
  commitConnect: commitConnectOutline,
  undoConnectPoint,
  deletePathPoints: deleteSelectedPathPoints,
  clearPathPoints: clearPathPointSelection,
  nudgePathPoints: nudgeSelectedPathPoints,
  nudge: (move) => applyAffineToActive(move, 1),
  stepPrev: prevStroke,
  stepNext: nextStroke,
  play,
  stop,
  cancelKnife,
  cancelConnect,
})

onMounted(() => {
  void loadList()
  void refreshOllamaStatus()
})
</script>

<template>
  <a href="#main-content" class="skip-link visually-hidden">본문으로 건너뛰기</a>
  <div class="app">
    <CharacterSidebar
      v-model:query="query"
      v-model:status-filter="statusFilter"
      :theme-mode="themeMode"
      :counts="statusCounts"
      :rows="filteredChars"
      :total="chars.length"
      :selected-unicode="selected?.unicode"
      @select-theme="setTheme"
      @search="loadList"
      @submit="openFirst"
      @clear-search="clearSearch"
      @open="openChar"
      @upload="uploadInitial"
    />

    <main id="main-content" class="studio-workspace" tabindex="-1">
      <!-- 1. 상단 통합 옵션 및 문서 액션 바 -->
      <StudioTopBar
        :selected="selected"
        :tool="activeTool"
        :scope="transformScope"
        :transform-mode="transformMode"
        :editable-layer="editableLayer"
        :locked="isEditableLocked"
        :has-font="Boolean(fontLayer?.paths.length)"
        :knife-points="knifePoints"
        :knife-mode="knifeMode"
        :connect-points="connectPoints"
        :dirty-count="dirtyIds.size"
        :layer-dirty="editableLayer ? dirtyIds.has(editableLayer.id) : false"
        :work-stroke-count="workStrokeCount"
        :busy="busy"
        :selected-path-point-count="selectedPathPoints.size"
        :can-edit-path-points="canEditPathPoints"
        :can-delete-path-points="canDeleteSelectedPathPoints"
        @change-scope="transformScope = $event"
        @change-transform-mode="transformMode = $event"
        @select-tool="selectTool"
        @auto-fit="autoFitToFont"
        @reset-edits="resetActiveEdits"
        @insert-path-point="insertPathPointFromSelection"
        @toggle-path-curve="toggleSelectedPathCurve"
        @simplify-path-points="simplifySelectedPathPoints"
        @delete-path-points="deleteSelectedPathPoints"
        @clear-path-points="clearPathPointSelection"
        @reverse-median="reverseActiveStrokeMedian()"
        @resegment="resegmentActiveByFont"
        @change-knife-mode="knifeMode = $event"
        @cancel-knife="cancelKnife"
        @cancel-connect="cancelConnect"
        @undo-connect="undoConnectPoint"
        @commit-connect="commitConnectOutline"
        @commit-bridge="commitConnectBridge"
        @unlock="unlockActiveLayers"
        @save="saveAllDirtyLayers"
        @approve="approve"
        @undo="undo"
        @compile="compileChar"
        @naver="applyNaver"
        @ollama="ollamaDialog?.open()"
        @ollama-split="ollamaSplitDialog?.open()"
        @conversions="conversionsDialog?.open()"
        @import-svg="importSvg"
        @import-image="importImage"
      />

      <!-- 2. 중앙 비스크롤 스튜디오 바디: [도구 레일 | 캔버스 스테이지 | 우측 인스펙터 독] -->
      <div class="studio-body">
        <ToolRail :tool="activeTool" @select="selectTool" />

        <section class="canvas-stage" aria-label="레이어 캔버스 뷰어">
          <div class="canvas-viewport">
            <LayerCanvas
              :selected="selected"
              :ordered-layers="orderedLayers"
              :editable-layer="editableLayer"
              :locked="isEditableLocked"
              :tool="activeTool"
              :scope="transformScope"
              :transform-mode="transformMode"
              :selected-index="selectedStrokeIndex"
              :selected-path-points="selectedPathPoints"
              :shown="shown"
              :reveal="reveal"
              :knife-points="knifePoints"
              :connect-points="connectPoints"
              :hidden-items="hiddenItemsByLayer"
              @select-item="selectStrokeItem"
              @knife-point="applyKnifePoint"
              @connect-point="applyConnectPoint"
              @commit-connect="commitConnectOutline"
              @restore-snapshot="restoreActiveSnapshot"
              @transform-by="applyAffineToActive"
              @update-path="updateSinglePathInActive"
              @select-path-points="setPathPointSelection"
              @toggle-path-point="togglePathPointSelection"
              @delete-path-point="deletePathPointAt"
              @insert-path-point-at="insertPathPointAtPos"
              @move-median-vertex="moveMedianVertex"
              @add-median-vertex="addMedianVertex"
              @delete-median-vertex="deleteMedianVertex"
            />
          </div>

          <StepControls
            :has-selection="!!selected"
            :shown="shown"
            :total="workStrokeCount"
            :playing="playing"
            @first="firstStroke"
            @prev="prevStroke"
            @next="nextStroke"
            @all="showAll"
            @toggle-play="playing ? stop() : play()"
          />
        </section>

        <aside class="inspector-dock" aria-label="레이어 및 획 인스펙터">
          <LayersPanel
            :layers="panelLayers"
            :active-layer-id="activeLayerId"
            :dirty-ids="dirtyIds"
            :busy="busy"
            :has-selection="!!selected"
            @select="selectLayer"
            @toggle-visible="toggleLayerVisible"
            @solo="soloLayer"
            @preset="setPresetVisibility"
            @change-opacity="setLayerOpacity"
            @toggle-lock="toggleLayerLock"
            @change-color="setLayerColor"
            @rename="renameLayer"
            @reorder="moveLayerOrder"
            @fetch-layer="fetchReferenceForLayer"
            @apply-layer="applyLayerToWorkStrokes"
            @duplicate="duplicateActiveLayer"
            @reset="resetLayerToOriginal"
            @remove="deleteActiveCustomLayer"
          />

          <StrokeList
            :layer="editableLayer"
            :selected-index="selectedStrokeIndex"
            :locked="isEditableLocked"
            :font-contour-count="fontLayer?.paths.length ?? 0"
            :guide-layers="outlineGuideLayers"
            :hidden-indices="activeHiddenItems"
            @select="selectStrokeItem"
            @toggle-hidden="toggleStrokeItemVisible"
            @visibility-preset="setStrokeItemsVisibility"
            @set-radical="setStrokeRadical"
            @set-cap="onSetCap"
            @move="moveStrokeInActive"
            @reverse="reverseActiveStrokeMedian"
            @merge-next="mergeStrokeWithNext"
            @remove="deleteStrokeAt"
            @copy-to-work="copyStrokeToWorkLayer"
            @generate-outline="generateOutlineLayer"
            @map-contours="mapOutlineContours"
            @refresh-outline="refreshOutlineMapping"
          />

          <section class="inspector-ollama-bar" aria-labelledby="ollama-dock-title">
            <div class="inspector-ollama-head">
              <h3 id="ollama-dock-title" class="ollama-dock-title">로컬 Ollama</h3>
              <span
                class="ollama-status-pill"
                :class="ollamaStatus?.connected ? 'is-ok' : 'is-off'"
                :title="ollamaStatus?.connected ? `연결됨 (${activeModelLabel})` : '로컬 Ollama 미연결'"
              >
                <span class="ollama-dot" aria-hidden="true" />
                <span>{{ activeModelLabel }}</span>
              </span>
            </div>
            <div class="inspector-ollama-actions">
              <button
                type="button"
                class="ollama-dock-btn primary"
                :disabled="!selected || busy"
                title="로컬 Ollama로 현재 궁서체 윤곽을 네이버 또는 Hanzi 획순에 맞게 분리합니다"
                @click="ollamaSplitDialog?.open()"
              >
                궁서체 획 분리
              </button>
              <button
                type="button"
                class="ollama-dock-btn"
                :disabled="!selected || busy"
                title="로컬 Ollama로 IDS 구조식을 추론하고 부품 획을 합성합니다"
                @click="ollamaDialog?.open()"
              >
                IDS 합성
              </button>
            </div>
          </section>
        </aside>
      </div>

      <!-- 3. 하단 고정 상태 바 -->
      <footer class="studio-statusbar" aria-live="polite" aria-atomic="true">
        <div class="status-left">
          <progress v-if="busy" class="loading-spinner" aria-label="작업 처리 중"></progress>
          <span v-else class="status-dot" :class="{ 'is-err': !!error }" aria-hidden="true" />
          <span v-if="error" class="status-err" role="alert">{{ error }}</span>
          <span v-else class="status-msg">{{ message }}</span>
        </div>
        <div class="status-shortcuts" aria-hidden="true">
          <span><kbd>V</kbd> 선택</span>
          <span><kbd>A</kbd> 정점</span>
          <span><kbd>M</kbd> 중심선</span>
          <span><kbd>K</kbd> 분할</span>
          <span><kbd>Space</kbd> 재생</span>
          <span><kbd>⌘S</kbd> 저장</span>
        </div>
      </footer>
    </main>

    <ConfirmDialog ref="confirmDialog" title="이미지로 작업 획 바꾸기">
      현재 획 데이터를 이미지에서 뽑은 획으로 바꿉니다.<br />
      바뀐 뒤에도 실행 취소로 되돌릴 수 있습니다.
    </ConfirmDialog>
    <ImportChoiceDialog ref="importChoice">
      작업 획에 이미 획이 있습니다.<br />
      지우고 가져온 획만 쓸지, 기존 획 뒤에 덧붙일지 고르세요.
    </ImportChoiceDialog>
    <OllamaIdsDialog
      ref="ollamaDialog"
      :selected="selected"
      :busy="busy"
      @apply="applyOllama"
    />
    <OllamaSplitDialog
      ref="ollamaSplitDialog"
      :selected="selected"
      :font-contour-count="fontLayer?.paths.length ?? 0"
      :busy="busy"
      @split="applyOllamaSplit"
    />
    <ConversionsDialog
      ref="conversionsDialog"
      :selected="selected"
    />
  </div>
</template>
