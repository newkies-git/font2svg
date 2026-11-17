<script setup lang="ts">
type LoupeLens = { cx: number; cy: number; sx: number; sy: number }

defineProps<{
  lens: LoupeLens
  zoom: number
  radius: number
}>()
</script>

<template>
  <!-- 돋보기: 정밀 도구(베지어·중심선·칼·윤곽연결)에서 커서 주변을 확대 -->
  <g
    class="overlay-loupe"
    aria-hidden="true"
    style="pointer-events: none"
  >
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
      :x1="lens.cx - 10"
      :y1="lens.cy"
      :x2="lens.cx + 10"
      :y2="lens.cy"
      class="loupe-cross"
    />
    <line
      :x1="lens.cx"
      :y1="lens.cy - 10"
      :x2="lens.cx"
      :y2="lens.cy + 10"
      class="loupe-cross"
    />
    <line
      class="loupe-leader"
      :x1="lens.sx"
      :y1="lens.sy"
      :x2="lens.cx"
      :y2="lens.cy"
    />
    <circle :cx="lens.sx" :cy="lens.sy" r="3" class="loupe-focus" />
  </g>
</template>
