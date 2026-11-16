<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import CharacterSidebar from './components/CharacterSidebar.vue'
import ConfirmDialog from './components/ConfirmDialog.vue'
import LayerCanvas from './components/LayerCanvas.vue'
import LayersPanel from './components/LayersPanel.vue'
import StepControls from './components/StepControls.vue'
import StrokeList from './components/StrokeList.vue'
import StudioTopBar from './components/StudioTopBar.vue'
import ToolRail from './components/ToolRail.vue'
import { createBusyRunner } from './composables/useBusyAction.ts'
import { useCharacterList } from './composables/useCharacterList.ts'
import { useLayerWorkspace } from './composables/useLayerWorkspace.ts'
import { usePlayback } from './composables/usePlayback.ts'
import { useTheme } from './composables/useTheme.ts'
import { apiRequest, apiUrl, characterUrl } from './lib/api.ts'
import { MISSING_FETCH_LIMIT, LAYER_ID } from './lib/constants.ts'
import { issueLabel } from './lib/labels.ts'
import type { CharacterDetail, CharacterSummary } from './types.ts'

const selected = ref<CharacterDetail | null>(null)
const message = ref('편집할 한자를 좌측 목록에서 선택하세요.')
const error = ref('')
const busy = ref(false)
const run = createBusyRunner(busy, error)
const shown = ref(0)
const reveal = ref(1)
const confirmDialog = ref<InstanceType<typeof ConfirmDialog> | null>(null)

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
  activeLayer,
  editableLayer,
  isEditableLocked,
  activeTool,
  transformScope,
  transformMode,
  selectedStrokeIndex,
  knifeFrom,
  connectPoints,
  dirtyIds,
  syncFromDetail,
  selectLayer,
  selectTool,
  selectStrokeItem,
  toggleLayerVisible,
  soloLayer,
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
  alignActiveToFont,
  autoFitToFont,
  updateSinglePathInActive,
  moveMedianVertex,
  addMedianVertex,
  deleteMedianVertex,
  cancelKnife,
  applyKnifePoint,
  cancelConnect,
  undoConnectPoint,
  applyConnectPoint,
  commitConnectOutline,
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
} = useLayerWorkspace(selected, shown, reveal, message, error, busy, loadList, stop)

// 획 윤곽 자동 매핑에서 중심선 길잡이로 쓸 수 있는 레이어(획이 있는 레이어, 작업 획 우선)
const outlineGuideLayers = computed(() => layers.value
  .filter((l) => l.id !== LAYER_ID.outline && l.strokes.length > 0)
  .sort((a, b) => Number(b.id === LAYER_ID.strokes) - Number(a.id === LAYER_ID.strokes) || a.z_index - b.z_index))

function unlockActiveLayers() {
  if (activeLayer.value?.locked) toggleLayerLock(activeLayer.value.id)
  if (editableLayer.value?.locked && editableLayer.value.id !== activeLayer.value?.id) {
    toggleLayerLock(editableLayer.value.id)
  }
  if (activeLayer.value && !activeLayer.value.visible) toggleLayerVisible(activeLayer.value.id, false)
  if (editableLayer.value && !editableLayer.value.visible) toggleLayerVisible(editableLayer.value.id, false)
}

function onGlobalKeyDown(event: KeyboardEvent) {
  const tag = (event.target as HTMLElement)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
  if (!selected.value) return

  const keyLower = event.key.toLowerCase()
  if ((event.metaKey || event.ctrlKey) && !event.altKey) {
    if (keyLower === 's') {
      event.preventDefault()
      if (!busy.value) void saveAllDirtyLayers()
      return
    }
    if (keyLower === 'z' && !event.shiftKey) {
      event.preventDefault()
      if (!busy.value && selected.value.history_count > 0) void undo()
      return
    }
    return
  }
  if (event.altKey) return

  if (keyLower === 'v') {
    event.preventDefault()
    selectTool('select')
    return
  }
  if (keyLower === 'a') {
    event.preventDefault()
    selectTool('bezier')
    return
  }
  if (keyLower === 'm') {
    event.preventDefault()
    selectTool('median')
    return
  }
  if (keyLower === 'k') {
    event.preventDefault()
    selectTool('knife')
    return
  }
  if (keyLower === 'p') {
    event.preventDefault()
    selectTool('connect')
    return
  }

  if (activeTool.value === 'connect') {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitConnectOutline()
      return
    }
    if (event.key === 'Backspace') {
      event.preventDefault()
      undoConnectPoint()
      return
    }
  }

  if (event.shiftKey && activeTool.value === 'select' && !isEditableLocked.value) {
    const step = 2
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      applyAffineToActive((x, y) => [x - step, y], 1)
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      applyAffineToActive((x, y) => [x + step, y], 1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      applyAffineToActive((x, y) => [x, y + step], 1)
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      applyAffineToActive((x, y) => [x, y - step], 1)
      return
    }
  }

  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    if (shown.value > 1) {
      shown.value -= 1
      reveal.value = 1
      selectedStrokeIndex.value = Math.max(0, shown.value - 1)
    }
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    if (shown.value < workStrokeCount.value) {
      shown.value += 1
      reveal.value = 1
      selectedStrokeIndex.value = shown.value - 1
    }
  } else if (event.key === ' ') {
    event.preventDefault()
    if (playing.value) stop()
    else play()
  } else if (event.key === 'Escape') {
    if (knifeFrom.value) cancelKnife()
    else if (connectPoints.value.length) cancelConnect()
  }
}

async function uploadInitial(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  await run(async () => {
    const entries = JSON.parse(await file.text()) as unknown
    const body = await apiRequest<{ imported: number }>(
      apiUrl('import'),
      '파일 업로드 실패: 올바른 한자 JSON 형식인지 확인하세요.',
      { method: 'POST', body: { entries } },
    )
    message.value = `${body.imported}자 등록 완료. 한자 선택 시 레퍼런스 획 데이터를 수신합니다.`
    await loadList()
  }, '초기 파일 업로드 실패: 파일 형식과 인코딩을 확인하세요.')
}

function openFirst() {
  if (chars.value.length > 0) openChar(chars.value[0])
}

async function openChar(row: CharacterSummary) {
  stop()
  await run(async () => {
    const detail = await apiRequest<CharacterDetail>(characterUrl(row.unicode), '한자 정보 조회 실패: 잠시 후 다시 시도하세요.')
    if (detail.strokes.length === 0 && !detail.issue_status) {
      await apiRequest(characterUrl(row.unicode, 'reference'), '레퍼런스 데이터 수신 실패: 잠시 후 다시 시도하세요.', { method: 'POST' })
      return openChar(row)
    }
    selected.value = detail
    syncFromDetail(detail)
    message.value = [
      detail.char,
      detail.reading,
      detail.origin ? `출처 ${detail.origin}` : '',
      issueLabel(detail),
      detail.issue_status === 'OPEN' ? detail.issue_reason : '',
    ]
      .filter(Boolean)
      .join(' · ')
  }, '한자 상세 정보 조회 실패: 잠시 후 다시 시도하세요.')
}

async function reload() {
  if (!selected.value) return
  const unicode = selected.value.unicode
  await loadList()
  const row = chars.value.find((item) => item.unicode === unicode)
  if (row) await openChar(row)
}

async function pullReference() {
  const current = selected.value
  if (!current) return
  await run(async () => {
    const body = await apiRequest<{ source: string }>(
      characterUrl(current.unicode, 'reference'),
      '레퍼런스 데이터 수신 실패: 잠시 후 다시 시도하세요.',
      { method: 'POST' },
    )
    message.value = body.source === 'NONE' ? '참조 출처(Hanja, IDS) 검색 결과 없음' : `${body.source} 레퍼런스 데이터 반영 완료`
    await reload()
  }, '레퍼런스 데이터 수신 실패: 네트워크 상태를 확인하세요.')
}

async function approve() {
  const current = selected.value
  if (!current) return
  await run(async () => {
    await apiRequest(characterUrl(current.unicode, 'approve'), '승인 실패: 작업 데이터를 확인하세요.', { method: 'POST' })
    message.value = '작업 데이터를 승인해 최종 획(strokes)으로 옮겼습니다.'
    await reload()
  }, '승인 실패: 서버 상태를 확인하세요.')
}

async function importSvg(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  const current = selected.value
  if (!current || !file) return
  await run(async () => {
    await apiRequest(
      characterUrl(current.unicode, 'import-svg'),
      'SVG 가져오기 실패: AnimCJK 형식 SVG인지 확인하세요.',
      { method: 'POST', body: { svg: await file.text() } },
    )
    message.value = 'SVG를 작업 데이터로 가져왔습니다. 확인 후 승인하세요.'
    await reload()
  }, 'SVG 가져오기 실패: 서버 상태를 확인하세요.')
}

async function applyNaver() {
  const current = selected.value
  if (!current) return
  if (workStrokeCount.value > 0) {
    const confirmed = await confirmDialog.value?.ask()
    if (!confirmed) return
  }
  await run(async () => {
    await apiRequest(characterUrl(current.unicode, 'apply-naver'), '네이버 획순 적용 실패: 잠시 후 다시 시도하세요.', { method: 'POST' })
    message.value = '네이버 한자사전 획순을 적용했습니다.'
    await reload()
  }, '네이버 획순 적용 실패: 네트워크 상태를 확인하세요.')
}

async function undo() {
  const current = selected.value
  if (!current) return
  try {
    const detail = await apiRequest<CharacterDetail>(characterUrl(current.unicode, 'undo'), '되돌리기 실패: 이전 편집 이력이 없습니다.', { method: 'POST' })
    selected.value = detail
    syncFromDetail(detail)
    message.value = '이전 편집 상태로 복원 완료'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '되돌리기 실패: 이전 편집 이력이 없습니다.'
  }
}

async function compileChar() {
  const current = selected.value
  if (!current) return
  if (dirtyIds.value.has(LAYER_ID.strokes)) {
    await saveAllDirtyLayers()
    if (error.value) return
  }
  try {
    await apiRequest(characterUrl(current.unicode, 'compile'), '컴파일 실패: 획 데이터 유효성을 확인하세요.', { method: 'POST' })
    message.value = '배포용 컴파일 JSON 생성 완료'
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '컴파일 실패: 획 데이터 유효성을 확인하세요.'
  }
  await reload()
}

async function syncMissing() {
  await run(async () => {
    const body = await apiRequest<{ tried: number }>(
      apiUrl('sync-missing'),
      '일괄 레퍼런스 조회 실패: 서버 상태를 확인하세요.',
      { method: 'POST', body: { limit: MISSING_FETCH_LIMIT } },
    )
    message.value = `미완료 한자 ${body.tried}자 레퍼런스 조회 완료`
    await loadList()
  }, '일괄 레퍼런스 조회 실패: 네트워크 상태를 확인하세요.')
}

function firstStroke() {
  shown.value = 1
  reveal.value = 1
  selectedStrokeIndex.value = 0
}

function prevStroke() {
  shown.value = Math.max(1, shown.value - 1)
  reveal.value = 1
  selectedStrokeIndex.value = Math.max(0, shown.value - 1)
}

function nextStroke() {
  shown.value = Math.min(workStrokeCount.value, shown.value + 1)
  reveal.value = 1
  selectedStrokeIndex.value = Math.max(0, shown.value - 1)
}

onMounted(() => {
  window.addEventListener('keydown', onGlobalKeyDown)
  loadList()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeyDown)
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
        :knife-from="knifeFrom"
        :connect-points="connectPoints"
        :dirty-count="dirtyIds.size"
        :work-stroke-count="workStrokeCount"
        :busy="busy"
        @change-scope="transformScope = $event"
        @change-transform-mode="transformMode = $event"
        @align-font="alignActiveToFont"
        @auto-fit="autoFitToFont"
        @reverse-median="reverseActiveStrokeMedian()"
        @resegment="resegmentActiveByFont"
        @cancel-knife="cancelKnife"
        @cancel-connect="cancelConnect"
        @undo-connect="undoConnectPoint"
        @commit-connect="commitConnectOutline"
        @unlock="unlockActiveLayers"
        @save="saveAllDirtyLayers"
        @approve="approve"
        @undo="undo"
        @compile="compileChar"
        @naver="applyNaver"
        @reference="pullReference"
        @import-svg="importSvg"
        @sync="syncMissing"
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
              :shown="shown"
              :reveal="reveal"
              :knife-from="knifeFrom"
              :connect-points="connectPoints"
              @select-item="selectStrokeItem"
              @knife-point="applyKnifePoint"
              @connect-point="applyConnectPoint"
              @commit-connect="commitConnectOutline"
              @restore-snapshot="restoreActiveSnapshot"
              @transform-by="applyAffineToActive"
              @update-path="updateSinglePathInActive"
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
            @select="selectStrokeItem"
            @set-radical="setStrokeRadical"
            @set-cap="setStrokeCap"
            @move="moveStrokeInActive"
            @reverse="reverseActiveStrokeMedian"
            @merge-next="mergeStrokeWithNext"
            @remove="deleteStrokeAt"
            @copy-to-work="copyStrokeToWorkLayer"
            @generate-outline="generateOutlineLayer"
            @map-contours="mapOutlineContours"
            @refresh-outline="refreshOutlineMapping"
          />
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

    <ConfirmDialog ref="confirmDialog" title="네이버 획순 적용">
      현재 획 데이터를 네이버 한자사전 획순으로 바꿉니다.<br />
      바뀐 뒤에도 실행 취소로 되돌릴 수 있습니다.
    </ConfirmDialog>
  </div>
</template>
