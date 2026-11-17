<script setup lang="ts">
import type { KnifeMode, Pt } from '../../../shared/types.ts'

defineProps<{
  knifePoints: Pt[]
  knifeMode: KnifeMode
}>()

const KNIFE_MODES: { mode: KnifeMode; label: string; hint: string }[] = [
  { mode: 'cut', label: '자르기', hint: '칼 선으로 윤곽을 가릅니다. 점 둘을 클릭하고, 꺾으려면 Shift+클릭' },
  { mode: 'extract', label: '교차 분리', hint: '분리할 획의 중심을 따라 안내선을 긋습니다. 교차부는 두 획이 함께 가집니다(十의 ―와 ㅣ)' },
]

const emit = defineEmits<{
  changeKnifeMode: [mode: KnifeMode]
  cancelKnife: []
}>()
</script>

<template>
  <template v-if="knifePoints.length > 0">
    <span class="knife-inline-pill" role="status">
      {{ knifeMode === 'extract' ? '안내선' : '칼' }} 점 {{ knifePoints.length }}개 — 끝점 클릭 (꺾으려면 Shift+클릭)
    </span>
    <button type="button" class="bar-btn" @click="emit('cancelKnife')">취소 (Esc)</button>
  </template>
  <template v-else>
    <div class="seg-control" role="group" aria-label="칼 모드">
      <button
        v-for="option in KNIFE_MODES"
        :key="option.mode"
        type="button"
        :class="{ on: knifeMode === option.mode }"
        :aria-pressed="knifeMode === option.mode"
        :title="option.hint"
        @click="emit('changeKnifeMode', option.mode)"
      >
        {{ option.label }}
      </button>
    </div>
    <span class="knife-inline-pill" role="status" title="정밀 편집 시 커서 주변을 확대합니다">돋보기 ON</span>
  </template>
</template>
