<script setup lang="ts">
import { connectLabel, polylinePoints } from '../../lib/canvasGeometry.ts'
import { CONNECT_END_RADIUS, CONNECT_MID_RADIUS } from '../../lib/canvasMetrics.ts'
import type { Pt } from '../../../shared/types.ts'
import { MIN_CONNECT_POINTS } from '../../composables/useConnectTool.ts'

defineProps<{ connectPoints: Pt[] }>()
</script>

<template>
  <g class="overlay-connect">
    <polyline
      v-if="connectPoints.length > 1"
      :points="polylinePoints(connectPoints)"
      class="connect-guide"
    />
    <line
      v-if="connectPoints.length >= MIN_CONNECT_POINTS"
      class="connect-close-hint"
      :x1="connectPoints[connectPoints.length - 1][0]"
      :y1="connectPoints[connectPoints.length - 1][1]"
      :x2="connectPoints[0][0]"
      :y2="connectPoints[0][1]"
    />
    <g
      v-for="(pt, ptIdx) in connectPoints"
      :key="`cp-${ptIdx}`"
      :transform="`translate(${pt[0]} ${pt[1]})`"
    >
      <circle
        :r="ptIdx === 0 || ptIdx === connectPoints.length - 1 ? CONNECT_END_RADIUS : CONNECT_MID_RADIUS"
        class="connect-vertex"
        :class="{
          'is-start': ptIdx === 0,
          'is-end': ptIdx === connectPoints.length - 1 && ptIdx > 0,
        }"
      />
      <text transform="scale(1 -1)" class="connect-vertex-label" text-anchor="middle" dominant-baseline="central">
        {{ connectLabel(ptIdx, connectPoints.length) }}
      </text>
    </g>
  </g>
</template>
