<script setup lang="ts">
import type { Pt } from '../../../shared/types.ts'
import { KNIFE_POINT_RADIUS, KNIFE_PULSE_RADIUS } from '../../lib/canvasMetrics.ts'

defineProps<{ knifePoints: Pt[]; scale: number }>()
</script>

<template>
  <g>
    <polyline v-if="knifePoints.length > 1" :points="knifePoints.map(([x, y]) => `${x},${y}`).join(' ')" class="knife-path" />
    <g v-for="(point, index) in knifePoints" :key="index" :transform="`translate(${point[0]} ${point[1]})`">
      <circle v-if="index === 0" :r="KNIFE_PULSE_RADIUS * scale" class="knife-point-pulse" />
      <circle :r="KNIFE_POINT_RADIUS * scale" class="knife-point" />
    </g>
  </g>
</template>
