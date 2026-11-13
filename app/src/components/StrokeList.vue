<script setup lang="ts">
import { computed } from 'vue'
import type { CapType, LayerRecord, StrokeRecord } from '../types.ts'

const props = defineProps<{
  layer: LayerRecord | null
  selectedIndex: number
  locked: boolean
}>()

const emit = defineEmits<{
  select: [index: number]
  setRadical: [index: number, value: 0 | 1]
  setCap: [index: number, end: 'start' | 'end', value: CapType]
  move: [index: number, delta: number]
  reverse: [index: number]
  mergeNext: [index: number]
  remove: [index: number]
  copyToWork: [index: number]
}>()

const isContourMode = computed(() => props.layer?.kind === 'FONT' && props.layer.strokes.length === 0)
const strokes = computed<StrokeRecord[]>(() => props.layer?.strokes ?? [])
const currentStroke = computed<StrokeRecord | null>(() => strokes.value[props.selectedIndex] ?? null)
</script>

<template>
  <section class="dock-pane strokes-pane" aria-labelledby="strokes-pane-title">
    <div class="pane-header">
      <h3 id="strokes-pane-title">
        {{ isContourMode ? `윤곽 · ${layer?.name}` : `획 구성 · ${layer?.name ?? '없음'}` }}
      </h3>
      <span v-if="layer" class="pane-count">
        {{ isContourMode ? `${layer.paths.length}개` : `${strokes.length}획` }}
      </span>
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
          :class="{ 'is-current': index === selectedIndex }"
          @click="emit('select', index)"
        >
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
          :class="{ 'is-current': index === selectedIndex }"
          @click="emit('select', index)"
        >
          <span class="stroke-idx">{{ index + 1 }}</span>
          <span class="stroke-row-label">{{ index + 1 }}획</span>
          <span v-if="stroke.is_radical" class="rad-dot-badge">부수</span>
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

        <div class="cap-pair">
          <label class="cap-field">
            <span>기필</span>
            <select
              :disabled="locked"
              :value="currentStroke.start_cap_type"
              aria-label="선택 획 기필 캡"
              @change="emit('setCap', selectedIndex, 'start', ($event.target as HTMLSelectElement).value as CapType)"
            >
              <option value="NONE">기본</option>
              <option value="AUTO_ROUND">둥글게</option>
              <option value="REF_STAMP">도장</option>
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
              <option value="NONE">기본</option>
              <option value="AUTO_ROUND">둥글게</option>
              <option value="REF_STAMP">도장</option>
            </select>
          </label>
        </div>

        <div class="insp-actions" role="toolbar" aria-label="선택 획 편집 작업">
          <button
            v-if="layer && layer.id !== 'strokes'"
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

    <div v-else class="pane-empty">표시할 획 데이터가 없습니다.</div>
  </section>
</template>
