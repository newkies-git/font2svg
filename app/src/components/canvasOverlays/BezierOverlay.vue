<script setup lang="ts">
import type { bezierNodesOf } from '../../lib/canvasGeometry.ts'
import type { HandleRef } from '../../lib/vectorEdit.ts'
import { BEZIER_ANCHOR_SIZE, BEZIER_CONTROL_RADIUS } from '../../lib/canvasMetrics.ts'

defineProps<{ nodes: ReturnType<typeof bezierNodesOf> }>()

const emit = defineEmits<{ startDrag: [handle: HandleRef, event: PointerEvent] }>()
</script>

<template>
  <g class="overlay-bezier">
    <line
      v-for="(ln, lIdx) in nodes.lines"
      :key="`bl-${lIdx}`"
      :x1="ln.x1"
      :y1="ln.y1"
      :x2="ln.x2"
      :y2="ln.y2"
      class="bezier-arm"
    />
    <circle
      v-for="(ctrl, cIdx) in nodes.controls"
      :key="`bc-${cIdx}`"
      :cx="ctrl.x"
      :cy="ctrl.y"
      :r="BEZIER_CONTROL_RADIUS"
      class="bezier-ctrl-pt"
      @pointerdown="emit('startDrag', { kind: ctrl.kind, segIndex: ctrl.segIndex }, $event)"
    />
    <rect
      v-for="(anc, aIdx) in nodes.anchors"
      :key="`ba-${aIdx}`"
      :x="anc.x - BEZIER_ANCHOR_SIZE / 2"
      :y="anc.y - BEZIER_ANCHOR_SIZE / 2"
      :width="BEZIER_ANCHOR_SIZE"
      :height="BEZIER_ANCHOR_SIZE"
      class="bezier-anchor-pt"
      @pointerdown="emit('startDrag', { kind: 'anchor', segIndex: anc.segIndex }, $event)"
    />
  </g>
</template>
