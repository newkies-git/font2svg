<script setup lang="ts">
import type { ResizeDir } from '../../composables/useCanvasDrag.ts'
import type { TransformMode } from '../../lib/transformMath.ts'
import type { BBox } from '../../lib/vectorEdit.ts'
import { TRANSFORM_HANDLE_SIZE } from '../../lib/canvasMetrics.ts'

defineProps<{
  bbox: BBox
  handles: { dir: ResizeDir; x: number; y: number }[]
  transformMode: TransformMode
}>()

const emit = defineEmits<{
  startMove: [event: PointerEvent]
  startHandle: [dir: ResizeDir, event: PointerEvent]
}>()
</script>

<template>
  <g class="overlay-transform">
    <rect
      :x="bbox.minX"
      :y="bbox.minY"
      :width="Math.max(1, bbox.maxX - bbox.minX)"
      :height="Math.max(1, bbox.maxY - bbox.minY)"
      class="bbox-move-zone"
      @pointerdown.stop="emit('startMove', $event)"
    />
    <rect
      v-for="h in handles"
      :key="h.dir"
      :x="h.x - TRANSFORM_HANDLE_SIZE / 2"
      :y="h.y - TRANSFORM_HANDLE_SIZE / 2"
      :width="TRANSFORM_HANDLE_SIZE"
      :height="TRANSFORM_HANDLE_SIZE"
      class="bbox-handle"
      :data-dir="h.dir"
      :data-mode="transformMode"
      :rx="transformMode === 'rotate' ? TRANSFORM_HANDLE_SIZE / 2 : 0"
      @pointerdown="emit('startHandle', h.dir, $event)"
    />
  </g>
</template>
