<script setup lang="ts">
import { computed } from 'vue'
import { LOUPE_CROSS_HALF, LOUPE_FOCUS_RADIUS } from '../../lib/canvasMetrics.ts'
import { formatLoupeZoom } from '../../composables/useCanvasLoupe.ts'

type LoupeLens = { cx: number; cy: number; sx: number; sy: number }

const props = defineProps<{
  lens: LoupeLens
  zoom: number
  radius: number
}>()

const rim = computed(() => {
  const dx = props.lens.sx - props.lens.cx
  const dy = props.lens.sy - props.lens.cy
  const len = Math.hypot(dx, dy) || 1
  return {
    x: props.lens.cx + (dx / len) * props.radius,
    y: props.lens.cy + (dy / len) * props.radius,
  }
})
</script>

<template>
  <!-- 돋보기: 정밀 도구에서 커서 옆을 확대한다. 렌즈는 커서를 덮지 않는다. -->
  <g
    class="overlay-loupe"
    aria-hidden="true"
    style="pointer-events: none"
  >
    <line
      class="loupe-leader"
      :x1="lens.sx"
      :y1="lens.sy"
      :x2="rim.x"
      :y2="rim.y"
    />
    <circle :cx="lens.cx" :cy="lens.cy" :r="radius" class="loupe-backdrop" />
    <g clip-path="url(#loupe-clip)">
      <g
        :transform="`translate(${lens.cx} ${lens.cy}) scale(${zoom}) translate(${-lens.sx} ${-lens.sy})`"
      >
        <use href="#canvas-world" />
      </g>
    </g>
    <circle :cx="lens.cx" :cy="lens.cy" :r="radius" class="loupe-ring" />
    <line
      :x1="lens.cx - LOUPE_CROSS_HALF"
      :y1="lens.cy"
      :x2="lens.cx + LOUPE_CROSS_HALF"
      :y2="lens.cy"
      class="loupe-cross"
    />
    <line
      :x1="lens.cx"
      :y1="lens.cy - LOUPE_CROSS_HALF"
      :x2="lens.cx"
      :y2="lens.cy + LOUPE_CROSS_HALF"
      class="loupe-cross"
    />
    <text
      class="loupe-zoom"
      :x="lens.cx"
      :y="lens.cy + radius - 14"
      text-anchor="middle"
    >{{ formatLoupeZoom(zoom) }}×</text>
    <circle :cx="lens.sx" :cy="lens.sy" :r="LOUPE_FOCUS_RADIUS" class="loupe-focus" />
  </g>
</template>
