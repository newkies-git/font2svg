<script setup lang="ts">
import { computed } from 'vue'
import type { LayerColor, LayerRecord } from '../../shared/types.ts'
import { fromPercent, OPACITY_SLIDER, toPercent } from '../lib/percent.ts'

const props = defineProps<{
  activeLayer: LayerRecord | null
  hasSelection: boolean
}>()

const emit = defineEmits<{
  changeOpacity: [layerId: string, opacity: number]
  changeColor: [layerId: string, color: LayerColor]
}>()

const colorChoices: { id: LayerColor; label: string }[] = [
  { id: 'ink', label: '먹색' },
  { id: 'slate', label: '회청' },
  { id: 'blue', label: '파랑' },
  { id: 'violet', label: '보라' },
  { id: 'green', label: '초록' },
  { id: 'amber', label: '주황' },
  { id: 'rose', label: '분홍' },
  { id: 'none', label: '없음' },
]

const opacityPercent = computed(() => toPercent(props.activeLayer?.opacity ?? 1))
</script>

<template>
  <!-- PhotoCraft Blend/Opacity + Label Color Strip -->
  <div class="layer-props-strip" :class="{ disabled: !hasSelection || !activeLayer }">
    <div class="opacity-row">
      <label for="layer-opacity-range" class="prop-label">불투명도</label>
      <input
        id="layer-opacity-range"
        type="range"
:min="OPACITY_SLIDER.min"
        :max="OPACITY_SLIDER.max"
        :step="OPACITY_SLIDER.step"
        :disabled="!hasSelection || !activeLayer"
        :value="opacityPercent"
        @input="activeLayer && emit('changeOpacity', activeLayer.id, fromPercent(Number(($event.target as HTMLInputElement).value)))"
      />
      <span class="opacity-val">{{ opacityPercent }}%</span>
    </div>

    <div class="color-swatches" role="group" aria-label="레이어 색상 라벨">
      <button
        v-for="c in colorChoices"
        :key="c.id"
        type="button"
        class="swatch-btn"
        :class="{ selected: activeLayer?.label_color === c.id }"
        :data-color="c.id"
        :title="`색상 라벨: ${c.label}`"
        :disabled="!hasSelection || !activeLayer"
        @click="activeLayer && emit('changeColor', activeLayer.id, c.id)"
      />
    </div>
  </div>
</template>
