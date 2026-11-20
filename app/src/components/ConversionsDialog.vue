<script setup lang="ts">
import { ref } from 'vue'
import type { CharacterDetail, ConversionRecord } from '../../shared/types.ts'
import { fetchConversions } from '../lib/api.ts'

const props = defineProps<{
  selected: CharacterDetail | null
}>()

const dialog = ref<HTMLDialogElement | null>(null)
const items = ref<ConversionRecord[]>([])
const loading = ref(false)
const loadError = ref('')

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

function downloadSvg(item: ConversionRecord) {
  const blob = new Blob([item.result_svg], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${item.char}-${item.id}.svg`
  anchor.click()
  URL.revokeObjectURL(url)
}

function modeLabel(mode: string): string {
  return mode === 'GUIDED' ? '중심선 분할' : '덩어리=획'
}

function destinationLabel(destination: string): string {
  return destination === 'STROKES' ? '확정 획' : '작업 초안'
}

async function open() {
  const current = props.selected
  if (!current) return
  const targetUnicode = current.unicode
  items.value = []
  loadError.value = ''
  loading.value = true
  if (dialog.value) dialog.value.returnValue = ''
  dialog.value?.showModal()
  try {
    const rows = await fetchConversions(targetUnicode)
    if (props.selected?.unicode === targetUnicode) {
      items.value = rows
    }
  } catch (cause) {
    if (props.selected?.unicode === targetUnicode) {
      loadError.value = cause instanceof Error ? cause.message : '이미지 변환 이력을 불러오지 못했습니다.'
    }
  } finally {
    if (props.selected?.unicode === targetUnicode) {
      loading.value = false
    }
  }
}

function onClose() {
  if (dialog.value) dialog.value.returnValue = ''
}

defineExpose({ open })
</script>

<template>
  <dialog
    ref="dialog"
    class="app-dialog conversions-dialog"
    aria-labelledby="conversions-dialog-title"
    @close="onClose"
  >
    <div class="dialog-content">
      <div class="ollama-dialog-head">
        <div>
          <h3 id="conversions-dialog-title">이미지 변환 이력</h3>
          <p v-if="selected" class="ollama-char-sub">
            대상 한자: <strong lang="zh-Hani">{{ selected.char }}</strong> ({{ selected.reading ?? '독음 미등록' }} · {{ selected.unicode }})
          </p>
        </div>
      </div>

      <p v-if="loading" class="conversion-empty" role="status" aria-live="polite">변환 이력을 불러오는 중…</p>
      <p v-else-if="loadError" class="error" role="alert">{{ loadError }}</p>
      <p v-else-if="items.length === 0" class="conversion-empty">
        이 한자에는 저장된 이미지 → 획 SVG 변환 이력이 없습니다.
      </p>

      <ul v-else class="conversion-list">
        <li v-for="item in items" :key="item.id" class="conversion-card">
          <img
            :src="svgDataUrl(item.result_svg)"
            :alt="`${item.source_name} 변환 SVG 미리보기`"
            class="conversion-thumb"
          />
          <div class="conversion-meta">
            <div class="conversion-head">
              <strong>{{ item.source_name }}</strong>
              <span class="doc-tag">{{ item.stroke_count }}획</span>
              <span class="doc-tag">{{ modeLabel(item.mode) }}</span>
              <span class="doc-tag">{{ destinationLabel(item.destination) }}</span>
            </div>
            <p class="conversion-detail">
              {{ item.source_width }}×{{ item.source_height }} · 임계값 {{ item.threshold }}<template v-if="item.invert"> · 반전</template>
            </p>
            <div class="conversion-foot">
              <time :datetime="item.created_at">{{ item.created_at }}</time>
              <button type="button" class="foot-chip" @click="downloadSvg(item)">SVG 다운로드</button>
            </div>
          </div>
        </li>
      </ul>

      <form method="dialog" class="dialog-actions">
        <button type="submit" value="close" autofocus>닫기</button>
      </form>
    </div>
  </dialog>
</template>
