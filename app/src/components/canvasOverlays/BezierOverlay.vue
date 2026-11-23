<script setup lang="ts">
import type { PointMarquee } from '../../composables/useCanvasDrag.ts'
import type { bezierNodesOf } from '../../lib/canvasGeometry.ts'
import { BEZIER_ANCHOR_SIZE, BEZIER_CONTROL_RADIUS } from '../../lib/canvasMetrics.ts'
import type { HandleRef } from '../../../shared/vectorEdit.ts'

const props = defineProps<{
  path: string
  nodes: ReturnType<typeof bezierNodesOf>
  selectedIndices: Set<number>
  marquee: PointMarquee | null
  scale: number
}>()

const emit = defineEmits<{
  startAnchorDrag: [segIndex: number, event: PointerEvent]
  startControlDrag: [handle: HandleRef, event: PointerEvent]
  deleteAnchor: [segIndex: number]
  insertOnEdge: [event: MouseEvent]
}>()

function anchorSize(segIndex: number): number {
  return (props.selectedIndices.has(segIndex) ? BEZIER_ANCHOR_SIZE + 3 : BEZIER_ANCHOR_SIZE) * props.scale
}

function controlRadius(segIndex: number): number {
  return (props.selectedIndices.has(segIndex) ? BEZIER_CONTROL_RADIUS + 1.5 : BEZIER_CONTROL_RADIUS) * props.scale
}
</script>

<template>
  <g class="overlay-bezier">
    <path :d="path" class="bezier-outline-highlight" />
    <path
      :d="path"
      class="bezier-hit-path"
      @dblclick.stop="emit('insertOnEdge', $event)"
    />
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
      :r="controlRadius(ctrl.segIndex)"
      class="bezier-ctrl-pt"
      :class="{ 'is-selected': selectedIndices.has(ctrl.segIndex) }"
      @pointerdown="emit('startControlDrag', { kind: ctrl.kind, segIndex: ctrl.segIndex }, $event)"
    />
    <rect
      v-for="(anc, aIdx) in nodes.anchors"
      :key="`ba-${aIdx}`"
      :x="anc.x - anchorSize(anc.segIndex) / 2"
      :y="anc.y - anchorSize(anc.segIndex) / 2"
      :width="anchorSize(anc.segIndex)"
      :height="anchorSize(anc.segIndex)"
      class="bezier-anchor-pt"
      :class="{ 'is-selected': selectedIndices.has(anc.segIndex) }"
      @pointerdown="emit('startAnchorDrag', anc.segIndex, $event)"
      @contextmenu.prevent="emit('deleteAnchor', anc.segIndex)"
    />
    <rect
      v-if="marquee"
      class="point-marquee"
      :x="Math.min(marquee.x0, marquee.x1)"
      :y="Math.min(marquee.y0, marquee.y1)"
      :width="Math.abs(marquee.x1 - marquee.x0)"
      :height="Math.abs(marquee.y1 - marquee.y0)"
    />
  </g>
</template>
