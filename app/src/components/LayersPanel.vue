<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { LAYER_ID } from '../../shared/constants.ts'
import type { LayerColor, LayerRecord } from '../../shared/types.ts'
import { canApplyToStrokes, canFetch, canReset, isSoloedLayer, layerCountText } from '../lib/layerPanel.ts'
import LayerPropsStrip from './LayerPropsStrip.vue'
import LayerThumb from './LayerThumb.vue'

const props = defineProps<{
  layers: LayerRecord[]
  activeLayerId: string
  dirtyIds: Set<string>
  busy: boolean
  hasSelection: boolean
}>()

const emit = defineEmits<{
  select: [layerId: string]
  toggleVisible: [layerId: string, altKey: boolean]
  solo: [layerId: string]
  preset: [mode: 'all' | 'work' | 'none']
  changeOpacity: [layerId: string, opacity: number]
  toggleLock: [layerId: string]
  changeColor: [layerId: string, color: LayerColor]
  rename: [layerId: string, name: string]
  reorder: [layerId: string, targetLayerId: string]
  fetchLayer: [layerId: string]
  applyLayer: [layerId: string, mode: 'direct' | 'fit_font']
  duplicate: []
  reset: [layerId: string]
  remove: []
}>()

const activeLayer = computed(() => props.layers.find((l) => l.id === props.activeLayerId) ?? null)
const activeIndex = computed(() => props.layers.findIndex((l) => l.id === props.activeLayerId))

const renamingId = ref<string | null>(null)
const renameDraft = ref('')
const renameInput = ref<HTMLInputElement[] | null>(null)

async function startRename(layer: LayerRecord) {
  renamingId.value = layer.id
  renameDraft.value = layer.name
  await nextTick()
  const el = renameInput.value?.[0]
  el?.focus()
  el?.select()
}

function commitRename() {
  if (!renamingId.value) return
  const id = renamingId.value
  renamingId.value = null
  emit('rename', id, renameDraft.value)
}

function cancelRename() {
  renamingId.value = null
}

const dragSourceId = ref<string | null>(null)
const dragOverId = ref<string | null>(null)
const armedDragId = ref<string | null>(null)

function onDragStart(layerId: string, event: DragEvent) {
  dragSourceId.value = layerId
  event.dataTransfer?.setData('text/plain', layerId)
}

function onDrop(targetId: string) {
  if (dragSourceId.value && dragSourceId.value !== targetId) {
    emit('reorder', dragSourceId.value, targetId)
  }
  dragSourceId.value = null
  dragOverId.value = null
  armedDragId.value = null
}

function moveActiveStep(delta: -1 | 1) {
  const idx = activeIndex.value
  const cur = props.layers[idx]
  const target = props.layers[idx + delta]
  if (cur && target) emit('reorder', cur.id, target.id)
}
</script>

<template>
  <section class="dock-pane layers-pane" aria-labelledby="layers-pane-title">
    <div class="pane-header">
      <h3 id="layers-pane-title">레이어</h3>
      <div v-if="hasSelection" class="pane-head-links" role="group" aria-label="일괄 표시 전환">
        <button type="button" :disabled="busy" title="사용 가능한 모든 레이어 표시" @click="emit('preset', 'all')">전체</button>
        <button type="button" :disabled="busy" title="기본 작업 레이어만 표시" @click="emit('preset', 'work')">기본</button>
        <button type="button" :disabled="busy" title="모든 레이어 숨김" @click="emit('preset', 'none')">숨김</button>
      </div>
    </div>

    <LayerPropsStrip
      :active-layer="activeLayer"
      :has-selection="hasSelection"
      @change-opacity="(layerId, opacity) => emit('changeOpacity', layerId, opacity)"
      @change-color="(layerId, color) => emit('changeColor', layerId, color)"
    />

    <!-- Layer Stack Rows -->
    <ul v-if="hasSelection" class="layer-list" role="listbox" aria-label="레이어 스택">
      <li
        v-for="layer in layers"
        :key="layer.id"
        role="option"
        :aria-selected="layer.id === activeLayerId"
        class="layer-row"
        :class="{
          'is-active': layer.id === activeLayerId,
          'is-hidden': !layer.visible,
          'is-drag-over': dragOverId === layer.id,
        }"
        :draggable="armedDragId === layer.id"
        @click="emit('select', layer.id)"
        @dragstart="onDragStart(layer.id, $event)"
        @dragover.prevent="dragOverId = layer.id"
        @dragleave="dragOverId === layer.id && (dragOverId = null)"
        @drop.prevent="onDrop(layer.id)"
        @dragend="dragSourceId = null; dragOverId = null; armedDragId = null"
      >
        <!-- Eye Visibility Column -->
        <button
          type="button"
          class="layer-eye-btn"
          :class="{ 'is-off': !layer.visible }"
          :data-color="layer.label_color"
          :aria-pressed="layer.visible"
          :aria-label="`${layer.name} ${layer.visible ? '숨기기' : '표시'}`"
          :title="`${layer.name} ${layer.visible ? '숨기기' : '표시'} (Alt+클릭: 단독 보기)`"
          @click.stop="emit('toggleVisible', layer.id, $event.altKey)"
        >
          <svg v-if="layer.visible" class="eye-svg" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M1.8 9S4.5 4.2 9 4.2 16.2 9 16.2 9 13.5 13.8 9 13.8 1.8 9 1.8 9Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
            <circle cx="9" cy="9" r="2.3" fill="currentColor" />
          </svg>
          <svg v-else class="eye-svg off" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M3 15L15 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            <path d="M2.5 9S5 4.8 9 4.8 15.5 9 15.5 9 13 13.2 9 13.2 2.5 9 2.5 9Z" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 2" />
          </svg>
        </button>

        <LayerThumb :layer="layer" />

        <!-- Single-Line Layer Name + Meta -->
        <div class="layer-name-col" @dblclick.stop="startRename(layer)">
          <input
            v-if="renamingId === layer.id"
            ref="renameInput"
            v-model="renameDraft"
            type="text"
            class="layer-rename-input"
            aria-label="레이어 이름 변경"
            @click.stop
            @keydown.enter.prevent="commitRename"
            @keydown.escape.prevent="cancelRename"
            @blur="commitRename"
          />
          <div v-else class="layer-name-row">
            <span class="layer-name-text">{{ layer.name }}</span>
            <span v-if="dirtyIds.has(layer.id)" class="layer-dirty-dot" title="미저장 변경">●</span>
            <span v-else-if="layer.modified && layer.id !== LAYER_ID.strokes" class="layer-badge mod">편집됨</span>
            <span v-if="layerCountText(layer)" class="layer-count">{{ layerCountText(layer) }}</span>
          </div>
        </div>

        <!-- Right Compact Indicators -->
        <div class="layer-right-col" @click.stop>
          <button
            v-if="canFetch(layer)"
            type="button"
            class="row-pill-btn fetch"
            :disabled="busy"
            title="원격 출처에서 데이터 수신"
            @click="emit('fetchLayer', layer.id)"
          >
            수신
          </button>

          <button
            type="button"
            class="row-icon-btn solo"
            :class="{ active: isSoloedLayer(layers, layer.id) }"
            :aria-pressed="isSoloedLayer(layers, layer.id)"
            :title="isSoloedLayer(layers, layer.id) ? '단독 보기 해제' : `${layer.name} 단독 보기`"
            @click="emit('solo', layer.id)"
          >
            S
          </button>

          <button
            type="button"
            class="row-icon-btn lock"
            :class="{ locked: layer.locked }"
            :aria-label="`${layer.name} 잠금 토글`"
            :title="layer.locked ? '레이어 잠금 해제' : '레이어 잠금'"
            @click="emit('toggleLock', layer.id)"
          >
            <svg v-if="layer.locked" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <rect x="2.8" y="6.2" width="8.4" height="6" rx="1" fill="currentColor" />
              <path d="M4.5 6.2V4.4a2.5 2.5 0 0 1 5 0v1.8" stroke="currentColor" stroke-width="1.4" />
            </svg>
            <svg v-else viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <rect x="2.8" y="6.2" width="8.4" height="6" rx="1" stroke="currentColor" stroke-width="1.2" />
              <path d="M4.5 6.2V4.4a2.5 2.5 0 0 1 4.7-1.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>

          <span
            class="row-grip"
            title="드래그하여 순서 변경"
            aria-hidden="true"
            @pointerdown="armedDragId = layer.id"
            @pointerup="armedDragId = null"
          >⋮⋮</span>
        </div>
      </li>
    </ul>
    <div v-else class="pane-empty">한자를 선택하면 레이어가 표시됩니다.</div>

    <!-- PhotoCraft-style Compact Panel Footer (No duplicate Save button!) -->
    <div v-if="hasSelection && activeLayer" class="pane-footer">
      <div class="footer-left-actions">
        <button
          v-if="canApplyToStrokes(activeLayer)"
          type="button"
          class="foot-chip"
          :disabled="busy"
          title="선택 레이어의 획·중심선을 그대로 작업 획에 덮어씁니다"
          @click="emit('applyLayer', activeLayer.id, 'direct')"
        >
          작업 획 복사
        </button>
        <button
          v-if="canApplyToStrokes(activeLayer)"
          type="button"
          class="foot-chip"
          :disabled="busy"
          title="선택 레이어의 중심선으로 궁서체 윤곽을 분할해 작업 획에 반영합니다"
          @click="emit('applyLayer', activeLayer.id, 'fit_font')"
        >
          궁서체 분할
        </button>
        <button
          v-if="canReset(activeLayer, dirtyIds)"
          type="button"
          class="foot-chip"
          :disabled="busy"
          title="수정한 레이어를 원본 레퍼런스/폰트 데이터로 복원합니다"
          @click="emit('reset', activeLayer.id)"
        >
          원본 복원
        </button>
      </div>

      <div class="footer-right-icons">
        <button
          type="button"
          class="foot-icon-btn"
          :disabled="busy || activeIndex <= 0"
          title="선택 레이어 위로 이동"
          aria-label="선택 레이어 위로 이동"
          @click="moveActiveStep(-1)"
        >
          ↑
        </button>
        <button
          type="button"
          class="foot-icon-btn"
          :disabled="busy || activeIndex < 0 || activeIndex >= layers.length - 1"
          title="선택 레이어 아래로 이동"
          aria-label="선택 레이어 아래로 이동"
          @click="moveActiveStep(1)"
        >
          ↓
        </button>
        <button
          type="button"
          class="foot-icon-btn"
          :disabled="busy"
          title="현재 레이어를 새 커스텀 레이어로 복제"
          aria-label="레이어 복제"
          @click="emit('duplicate')"
        >
          ⧉
        </button>
        <button
          v-if="activeLayer.kind === 'CUSTOM'"
          type="button"
          class="foot-icon-btn danger"
          :disabled="busy"
          title="커스텀 레이어 삭제"
          aria-label="커스텀 레이어 삭제"
          @click="emit('remove')"
        >
          ✕
        </button>
      </div>
    </div>
  </section>
</template>
