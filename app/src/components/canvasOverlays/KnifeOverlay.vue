<script setup lang="ts">
import type { Pt } from '../../../shared/types.ts'

defineProps<{ knifePoints: Pt[] }>()
</script>

<template>
  <g>
    <polyline v-if="knifePoints.length > 1" :points="knifePoints.map(([x, y]) => `${x},${y}`).join(' ')" class="knife-path" />
    <g v-for="(point, index) in knifePoints" :key="index" :transform="`translate(${point[0]} ${point[1]})`">
      <circle v-if="index === 0" r="14" class="knife-point-pulse" />
      <circle r="5" class="knife-point" />
    </g>
  </g>
</template>
