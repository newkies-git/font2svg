<script setup lang="ts">
import { isContourLayer } from '../../shared/layerKind.ts'
import { LAYER_ID } from '../../shared/constants.ts'
import { computed, ref } from 'vue'
import type { CapType, LayerRecord, StrokeRecord } from '../../shared/types.ts'
import { CAP_OPTIONS } from '../lib/capLabels.ts'

const props = defineProps<{
  layer: LayerRecord | null
  selectedIndex: number
  locked: boolean
  fontContourCount: number
  guideLayers: LayerRecord[]
  hiddenIndices: Set<number>
}>()

const emit = defineEmits<{
  select: [index: number]
  toggleHidden: [index: number, altKey: boolean]
  visibilityPreset: [mode: 'all' | 'solo' | 'none']
  setRadical: [index: number, value: 0 | 1]
  setCap: [index: number, end: 'start' | 'end', value: CapType]
  move: [index: number, delta: number]
  reverse: [index: number]
  mergeNext: [index: number]
  remove: [index: number]
  copyToWork: [index: number]
  generateOutline: [sourceLayerId: string]
  mapContours: [index: number, contours: number[]]
  refreshOutline: []
}>()

const isContourMode = computed(() => (props.layer ? isContourLayer(props.layer) : false))
const strokes = computed<StrokeRecord[]>(() => props.layer?.strokes ?? [])
const currentStroke = computed<StrokeRecord | null>(() => strokes.value[props.selectedIndex] ?? null)
const totalCount = computed(() => (props.layer ? (isContourMode.value ? props.layer.paths.length : strokes.value.length) : 0))
const hiddenCount = computed(() => {
  let count = 0
  for (const idx of props.hiddenIndices) {
    if (idx >= 0 && idx < totalCount.value) count++
  }
  return count
})
const visibleCount = computed(() => Math.max(0, totalCount.value - hiddenCount.value))

// 획 윤곽(OUTLINE) 레이어: 궁서체 윤곽 매핑
const isOutlineMode = computed(() => props.layer?.kind === 'OUTLINE')
const guideId = ref('')
const effectiveGuideId = computed(() => (props.guideLayers.some((l) => l.id === guideId.value) ? guideId.value : (props.guideLayers[0]?.id ?? '')))
const unmappedCount = computed(() => strokes.value.filter((s) => !s.font_contours?.length).length)
const contourIndices = computed(() => Array.from({ length: props.fontContourCount }, (_, i) => i))

function isMapped(stroke: StrokeRecord): boolean {
  return (stroke.font_contours?.length ?? 0) > 0
}

function toggleContour(contour: number) {
  const stroke = currentStroke.value
  if (!stroke) return
  const current = stroke.font_contours ?? []
  const next = current.includes(contour) ? current.filter((i) => i !== contour) : [...current, contour]
  emit('mapContours', props.selectedIndex, next.sort((a, b) => a - b))
}
</script>

<template>
  <section class="dock-pane strokes-pane" aria-labelledby="strokes-pane-title">
    <div class="pane-header">
      <h3 id="strokes-pane-title">
        {{ isContourMode ? `윤곽 · ${layer?.name}` : `획 구성 · ${layer?.name ?? '없음'}` }}
      </h3>
      <div v-if="layer" class="pane-head-right">
        <div v-if="totalCount > 0" class="pane-head-links" role="group" aria-label="항목 일괄 표시 전환">
          <button type="button" title="모든 항목 표시" @click="emit('visibilityPreset', 'all')">전체</button>
          <button type="button" title="선택한 항목만 단독 보기" @click="emit('visibilityPreset', 'solo')">단독</button>
          <button type="button" title="모든 항목 숨김" @click="emit('visibilityPreset', 'none')">숨김</button>
        </div>
        <span class="pane-count">
          {{ hiddenCount > 0 ? `${visibleCount}/${totalCount}` : totalCount }}{{ isContourMode ? '개' : '획' }}
        </span>
      </div>
    </div>

    <!-- 획 윤곽: 자동 매핑 -->
    <div v-if="isOutlineMode" class="outline-map-bar">
      <select v-model="guideId" :disabled="locked || guideLayers.length === 0" aria-label="중심선 길잡이 레이어">
        <option v-for="g in guideLayers" :key="g.id" :value="g.id">{{ g.name }} ({{ g.strokes.length }}획)</option>
      </select>
      <button
        type="button"
        :disabled="locked || !effectiveGuideId || fontContourCount === 0"
        title="길잡이 레이어의 중심선으로 궁서체 윤곽을 획별로 나누고 자동 매핑합니다. 수동 매핑한 획은 유지됩니다."
        @click="emit('generateOutline', effectiveGuideId)"
      >
        {{ strokes.length > 0 ? '자동 매핑 다시' : '자동 매핑' }}
      </button>
      <span v-if="strokes.length > 0" class="map-summary" :class="{ 'has-unmapped': unmappedCount > 0 }">
        {{ unmappedCount > 0 ? `미매핑 ${unmappedCount}획` : '전체 매핑됨' }}
      </span>
    </div>

    <div v-if="isOutlineMode && layer?.stale" class="outline-stale" role="alert">
      <span>궁서체 윤곽이 바뀌어 매핑 번호가 어긋났을 수 있습니다.</span>
      <button type="button" :disabled="locked" @click="emit('refreshOutline')">매핑 갱신</button>
    </div>

    <!-- FONT 윤곽 목록 -->
    <template v-if="isContourMode && layer">
      <ul class="stroke-scroll" role="listbox" aria-label="윤곽 서브패스 목록">
        <li
          v-for="(_, index) in layer.paths"
          :key="`contour-${index}`"
          role="option"
          :aria-selected="index === selectedIndex"
          class="stroke-clean-row"
          :class="{ 'is-current': index === selectedIndex, 'is-hidden': hiddenIndices.has(index) }"
          @click="emit('select', index)"
        >
          <button
            type="button"
            class="stroke-eye-btn"
            :class="{ 'is-off': hiddenIndices.has(index) }"
            :aria-pressed="!hiddenIndices.has(index)"
            :aria-label="`윤곽 #${index + 1} ${hiddenIndices.has(index) ? '표시' : '숨기기'}`"
            :title="`윤곽 #${index + 1} ${hiddenIndices.has(index) ? '표시' : '숨기기'} (Alt+클릭: 단독 보기)`"
            @click.stop="emit('toggleHidden', index, $event.altKey)"
          >
            <svg v-if="!hiddenIndices.has(index)" class="eye-svg" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M1.8 9S4.5 4.2 9 4.2 16.2 9 16.2 9 13.5 13.8 9 13.8 1.8 9 1.8 9Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
              <circle cx="9" cy="9" r="2.3" fill="currentColor" />
            </svg>
            <svg v-else class="eye-svg off" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M3 15L15 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              <path d="M2.5 9S5 4.8 9 4.8 15.5 9 15.5 9 13 13.2 9 13.2 2.5 9 2.5 9Z" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 2" />
            </svg>
          </button>
          <span class="stroke-idx">{{ index + 1 }}</span>
          <span class="stroke-row-label">윤곽 서브패스 #{{ index + 1 }}</span>
        </li>
      </ul>

      <div class="stroke-inspector" :class="{ disabled: locked }">
        <div class="insp-actions">
          <button type="button" :disabled="locked || selectedIndex <= 0" title="위로 이동" @click="emit('move', selectedIndex, -1)">↑ 위로</button>
          <button type="button" :disabled="locked || selectedIndex >= layer.paths.length - 1" title="아래로 이동" @click="emit('move', selectedIndex, 1)">↓ 아래로</button>
          <button type="button" class="danger-text" :disabled="locked || layer.paths.length <= 1" title="윤곽 삭제" @click="emit('remove', selectedIndex)">삭제</button>
        </div>
      </div>
    </template>

    <!-- 획 목록 + 하단 단일 선택 획 속성 인스펙터 -->
    <template v-else-if="strokes.length > 0">
      <ul class="stroke-scroll" role="listbox" aria-label="획 목록">
        <li
          v-for="(stroke, index) in strokes"
          :key="`${layer?.id ?? 'none'}-${stroke.stroke_order}-${index}`"
          role="option"
          :aria-selected="index === selectedIndex"
          class="stroke-clean-row"
          :class="{ 'is-current': index === selectedIndex, 'is-hidden': hiddenIndices.has(index) }"
          @click="emit('select', index)"
        >
          <button
            type="button"
            class="stroke-eye-btn"
            :class="{ 'is-off': hiddenIndices.has(index) }"
            :aria-pressed="!hiddenIndices.has(index)"
            :aria-label="`${index + 1}획 ${hiddenIndices.has(index) ? '표시' : '숨기기'}`"
            :title="`${index + 1}획 ${hiddenIndices.has(index) ? '표시' : '숨기기'} (Alt+클릭: 단독 보기)`"
            @click.stop="emit('toggleHidden', index, $event.altKey)"
          >
            <svg v-if="!hiddenIndices.has(index)" class="eye-svg" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M1.8 9S4.5 4.2 9 4.2 16.2 9 16.2 9 13.5 13.8 9 13.8 1.8 9 1.8 9Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
              <circle cx="9" cy="9" r="2.3" fill="currentColor" />
            </svg>
            <svg v-else class="eye-svg off" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M3 15L15 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
              <path d="M2.5 9S5 4.8 9 4.8 15.5 9 15.5 9 13 13.2 9 13.2 2.5 9 2.5 9Z" stroke="currentColor" stroke-width="1.3" stroke-dasharray="2 2" />
            </svg>
          </button>
          <span class="stroke-idx">{{ index + 1 }}</span>
          <span class="stroke-row-label">{{ index + 1 }}획</span>
          <span v-if="stroke.is_radical" class="rad-dot-badge">부수</span>
          <span v-if="isOutlineMode" class="map-badge" :class="{ 'is-unmapped': !isMapped(stroke) }">
            {{ isMapped(stroke) ? `윤곽 ${stroke.font_contours?.map((i) => i + 1).join(',')}${stroke.map_manual ? ' ✎' : ''}` : '미매핑' }}
          </span>
          <span class="stroke-pts-meta">{{ stroke.median_points.length }}점 · 폭 {{ stroke.stroke_width }}</span>
        </li>
      </ul>

      <!-- 선택된 획 하나에 대한 마스터-디테일 속성 편집기 -->
      <div v-if="currentStroke" class="stroke-inspector">
        <div class="insp-top">
          <span class="insp-title">{{ selectedIndex + 1 }}획 속성</span>
          <label class="rad-chip" :class="{ 'is-radical': currentStroke.is_radical, disabled: locked }">
            <input
              type="checkbox"
              :disabled="locked"
              :checked="currentStroke.is_radical === 1"
              @change="emit('setRadical', selectedIndex, ($event.target as HTMLInputElement).checked ? 1 : 0)"
            />
            <span>부수 획</span>
          </label>
        </div>

        <div v-if="isOutlineMode" class="contour-map" role="group" aria-label="궁서체 윤곽 매핑">
          <span class="contour-map-label">궁서체 윤곽 {{ currentStroke.map_manual ? '(수동)' : '(자동)' }}</span>
          <div class="contour-chips">
            <label
              v-for="contour in contourIndices"
              :key="`map-${contour}`"
              class="contour-chip"
              :class="{ 'is-on': currentStroke.font_contours?.includes(contour), disabled: locked }"
            >
              <input
                type="checkbox"
                :disabled="locked"
                :checked="currentStroke.font_contours?.includes(contour)"
                @change="toggleContour(contour)"
              />
              <span>{{ contour + 1 }}</span>
            </label>
          </div>
          <button
            type="button"
            :disabled="locked || !isMapped(currentStroke)"
            title="매핑을 해제하고 중심선 띠 모양으로 되돌립니다"
            @click="emit('mapContours', selectedIndex, [])"
          >
            매핑 해제
          </button>
        </div>

        <div class="cap-pair">
          <label class="cap-field">
            <span>기필</span>
            <select
              :disabled="locked"
              :value="currentStroke.start_cap_type"
              aria-label="선택 획 기필 캡"
              @change="emit('setCap', selectedIndex, 'start', ($event.target as HTMLSelectElement).value as CapType)"
            >
              <option v-for="option in CAP_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <label class="cap-field">
            <span>수필</span>
            <select
              :disabled="locked"
              :value="currentStroke.end_cap_type"
              aria-label="선택 획 수필 캡"
              @change="emit('setCap', selectedIndex, 'end', ($event.target as HTMLSelectElement).value as CapType)"
            >
              <option v-for="option in CAP_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
        </div>

        <div class="insp-actions" role="toolbar" aria-label="선택 획 편집 작업">
          <button
            v-if="layer && layer.id !== LAYER_ID.strokes"
            type="button"
            title="이 획을 작업 획 레이어 끝에 추가합니다"
            @click="emit('copyToWork', selectedIndex)"
          >
            작업 획에 추가
          </button>
          <button
            type="button"
            :disabled="locked"
            title="기필↔수필 방향 반전"
            @click="emit('reverse', selectedIndex)"
          >
            방향 반전
          </button>
          <button
            type="button"
            :disabled="locked || selectedIndex >= strokes.length - 1"
            title="다음 획과 병합"
            @click="emit('mergeNext', selectedIndex)"
          >
            다음과 병합
          </button>
          <button
            type="button"
            :disabled="locked || selectedIndex <= 0"
            title="순서 위로 이동"
            aria-label="획 위로 이동"
            @click="emit('move', selectedIndex, -1)"
          >
            ↑
          </button>
          <button
            type="button"
            :disabled="locked || selectedIndex >= strokes.length - 1"
            title="순서 아래로 이동"
            aria-label="획 아래로 이동"
            @click="emit('move', selectedIndex, 1)"
          >
            ↓
          </button>
          <button
            type="button"
            class="danger-text"
            :disabled="locked || strokes.length <= 1"
            title="선택 획 삭제"
            aria-label="획 삭제"
            @click="emit('remove', selectedIndex)"
          >
            삭제
          </button>
        </div>
      </div>
    </template>

    <div v-else class="pane-empty">{{ isOutlineMode ? '[자동 매핑]으로 궁서체 윤곽을 획별로 나누세요.' : '표시할 획 데이터가 없습니다.' }}</div>
  </section>
</template>
