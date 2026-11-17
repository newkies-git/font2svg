<script setup lang="ts">
import { polylinePoints } from '../../lib/canvasGeometry.ts'
import type { Pt } from '../../../shared/types.ts'

defineProps<{ points: Pt[] }>()

const emit = defineEmits<{
  linePointerDown: [event: PointerEvent]
  vertexPointerDown: [index: number, event: PointerEvent]
  deleteVertex: [index: number]
}>()
</script>

<template>
  <g class="overlay-median-edit">
    <polyline
      :points="polylinePoints(points)"
      class="median-hit-line"
      @pointerdown="emit('linePointerDown', $event)"
    />
    <polyline
      :points="polylinePoints(points)"
      class="median-active-guide"
    />
    <g
      v-for="(pt, ptIdx) in points"
      :key="`mv-${ptIdx}`"
      :transform="`translate(${pt[0]} ${pt[1]})`"
      @pointerdown="emit('vertexPointerDown', ptIdx, $event)"
      @contextmenu.prevent="emit('deleteVertex', ptIdx)"
    >
      <circle
        :r="ptIdx === 0 || ptIdx === points.length - 1 ? 14 : 11"
        class="median-vertex"
        :class="{
          'is-start': ptIdx === 0,
          'is-end': ptIdx === points.length - 1 && ptIdx > 0,
        }"
      />
      <text
        v-if="ptIdx === 0 || ptIdx === points.length - 1"
        transform="scale(1 -1)"
        class="median-vertex-label"
        text-anchor="middle"
        dominant-baseline="central"
      >
        {{ ptIdx === 0 ? '기' : '수' }}
      </text>
    </g>
  </g>
</template>
