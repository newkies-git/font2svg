<script setup lang="ts">
import { CANVAS } from '../../shared/constants.ts'
import { thumbPaths } from '../lib/layerPanel.ts'
import type { LayerRecord } from '../../shared/types.ts'

defineProps<{ layer: LayerRecord }>()
</script>

<template>
  <div class="layer-thumb" :data-color="layer.label_color" aria-hidden="true">
    <svg v-if="thumbPaths(layer).length > 0" :viewBox="`0 0 ${CANVAS} ${CANVAS}`" class="thumb-svg">
      <g :transform="`translate(0 ${CANVAS}) scale(1 -1)`">
        <path v-for="(d, pIdx) in thumbPaths(layer)" :key="pIdx" :d="d" />
      </g>
    </svg>
    <svg v-else-if="layer.kind === 'MEDIANS'" class="thumb-icon" viewBox="0 0 16 16" fill="none">
      <path d="M3 12L7 6.5L10 9L13 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
    <span v-else-if="layer.kind === 'NUMBERS'" class="thumb-glyph">12</span>
    <span v-else class="thumb-glyph">—</span>
  </div>
</template>
