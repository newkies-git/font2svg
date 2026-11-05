<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { BADGE_RADIUS, CANVAS, MISSING_FETCH_LIMIT, REVEAL_STEP } from './lib/constants.ts'
import { recoverMedian, splitStrokeByKnife } from './lib/strokeCut.ts'
import type { CapType, CharacterDetail, CharacterSummary, IssueStatus, Pt, StrokeRecord } from './types.ts'

type ThemeMode = 'system' | 'light' | 'dark'

const ISSUE_LABELS: Record<IssueStatus, string> = { OPEN: '작업 전', DRAFT: '승인 대기', APPROVED: '승인됨' }

function issueLabel(detail: CharacterDetail): string {
  if (!detail.issue_status) return ''
  return `${ISSUE_LABELS[detail.issue_status]}${detail.in_font ? ' · 궁서체 있음' : ''}`
}

const chars = ref<CharacterSummary[]>([])
const query = ref('')
const selected = ref<CharacterDetail | null>(null)
const strokes = ref<StrokeRecord[]>([])
const message = ref('편집할 한자를 목록에서 선택하세요.')
const error = ref('')
const busy = ref(false)
const background = ref<'outline' | 'silhouette' | 'none'>('outline')
const showMedians = ref(true)
const showNumbers = ref(true)
const playing = ref(false)
const shown = ref(0)
const reveal = ref(1)
const knifeFrom = ref<Pt | null>(null)
const layer = ref<SVGGElement | null>(null)
const svgFileInput = ref<HTMLInputElement | null>(null)
const themeMode = ref<ThemeMode>('system')
const confirmDialog = ref<HTMLDialogElement | null>(null)
let confirmResolve: ((value: boolean) => void) | null = null

function askConfirm(): Promise<boolean> {
  return new Promise((resolve) => {
    confirmResolve = resolve
    confirmDialog.value?.showModal()
  })
}

function onConfirmClose() {
  const returnValue = confirmDialog.value?.returnValue
  confirmResolve?.(returnValue === 'confirm')
  confirmResolve = null
}

// Animation loop using requestAnimationFrame
let animFrameId = 0
let lastTimestamp = 0

// Reactive prefers-reduced-motion support
const motionMedia = typeof window !== 'undefined' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
const reducedMotion = ref(motionMedia?.matches ?? false)

function onMotionPreferenceChange(e: MediaQueryListEvent) {
  reducedMotion.value = e.matches
}

if (motionMedia) {
  motionMedia.addEventListener('change', onMotionPreferenceChange)
}

// Search AbortController to prevent race conditions
let listAbortController: AbortController | null = null

const fullOutline = computed(() => strokes.value.map((stroke) => stroke.outline_path).join(' '))
const visibleStrokes = computed(() => strokes.value.slice(0, Math.max(0, Math.min(strokes.value.length, shown.value))))

function applyTheme(mode: ThemeMode) {
  const meta = document.querySelector('meta[name="color-scheme"]')
  if (mode === 'system') {
    if (meta) meta.setAttribute('content', 'light dark')
    delete document.documentElement.dataset.theme
    try {
      localStorage.removeItem('color-scheme')
    } catch {}
  } else {
    if (meta) meta.setAttribute('content', mode)
    document.documentElement.dataset.theme = mode
    try {
      localStorage.setItem('color-scheme', mode)
    } catch {}
  }
}

function setTheme(mode: ThemeMode) {
  themeMode.value = mode
  applyTheme(mode)
}

function handleStorageChange(e: StorageEvent) {
  if (e.key === 'color-scheme') {
    const val = e.newValue
    if (val === 'dark' || val === 'light') {
      themeMode.value = val
      applyTheme(val)
    } else {
      themeMode.value = 'system'
      applyTheme('system')
    }
  }
}

async function uploadInitial(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  busy.value = true
  error.value = ''
  try {
    const entries = JSON.parse(await file.text()) as unknown
    const response = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? '파일 업로드 실패: 올바른 한자 JSON 형식인지 확인하세요.')
    message.value = `${body.imported}자 등록 완료. 한자 선택 시 레퍼런스 획 데이터를 수신합니다.`
    await loadList()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '초기 파일 업로드 실패: 파일 형식과 인코딩을 확인하세요.'
  } finally {
    busy.value = false
  }
}

async function loadList() {
  if (listAbortController) {
    listAbortController.abort()
  }
  listAbortController = new AbortController()

  try {
    const response = await fetch(`/api/characters?q=${encodeURIComponent(query.value)}`, {
      signal: listAbortController.signal,
    })
    if (!response.ok) throw new Error('한자 목록 조회 실패: 서버 연결 상태를 확인하세요.')
    chars.value = await response.json()
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') return
    error.value = cause instanceof Error ? cause.message : '한자 목록 조회 실패: 잠시 후 다시 시도하세요.'
  }
}

// IME-safe enter handling according to modern-web-guidance
function onSearchKeyDown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    if (event.isComposing || event.keyCode === 229) {
      return
    }
    event.preventDefault()
    if (chars.value.length > 0) {
      openChar(chars.value[0])
    }
  }
}

async function openChar(row: CharacterSummary) {
  stop()
  error.value = ''
  busy.value = true
  try {
    const response = await fetch(`/api/characters/${encodeURIComponent(row.unicode)}`)
    if (!response.ok) throw new Error('한자 정보 조회 실패: 잠시 후 다시 시도하세요.')
    const detail = (await response.json()) as CharacterDetail
    if (detail.strokes.length === 0 && !detail.issue_status) {
      const fetched = await fetch(`/api/characters/${encodeURIComponent(row.unicode)}/reference`, { method: 'POST' })
      const fetchedBody = await fetched.json()
      if (!fetched.ok) throw new Error(fetchedBody.error ?? '레퍼런스 데이터 수신 실패: 잠시 후 다시 시도하세요.')
      return openChar(row)
    }
    selected.value = detail
    strokes.value = detail.strokes.map((stroke) => ({
      ...stroke,
      median_points: stroke.median_points.map((point) => [...point] as Pt),
    }))
    shown.value = strokes.value.length
    reveal.value = 1
    message.value = [detail.char, detail.reading, detail.origin, detail.origin_url, issueLabel(detail), detail.issue_status === 'OPEN' ? detail.issue_reason : ''].filter(Boolean).join(' · ')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '한자 상세 정보 조회 실패: 잠시 후 다시 시도하세요.'
  } finally {
    busy.value = false
  }
}

async function reload() {
  if (!selected.value) return
  const unicode = selected.value.unicode
  await loadList()
  const row = chars.value.find((item) => item.unicode === unicode)
  if (row) await openChar(row)
}

async function pullReference() {
  if (!selected.value) return
  busy.value = true
  error.value = ''
  try {
    const response = await fetch(`/api/characters/${encodeURIComponent(selected.value.unicode)}/reference`, { method: 'POST' })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? '레퍼런스 데이터 수신 실패: 잠시 후 다시 시도하세요.')
    message.value = body.source === 'NONE' ? '참조 출처(Hanja, IDS) 검색 결과 없음' : `${body.source} 레퍼런스 데이터 반영 완료`
    await reload()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '레퍼런스 데이터 수신 실패: 네트워크 상태를 확인하세요.'
  } finally {
    busy.value = false
  }
}

async function saveStrokes(action: string) {
  if (!selected.value) return
  busy.value = true
  error.value = ''
  try {
    const response = await fetch(`/api/characters/${encodeURIComponent(selected.value.unicode)}/strokes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, strokes: strokes.value }),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? '획 데이터 저장 실패: 입력값을 확인 후 다시 시도하세요.')
    selected.value = body
    strokes.value = body.strokes
    message.value = '획 편집 데이터 저장 완료'
    await loadList()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '획 데이터 저장 실패: 서버 상태를 확인하세요.'
  } finally {
    busy.value = false
  }
}

async function approve() {
  if (!selected.value) return
  busy.value = true
  error.value = ''
  try {
    const response = await fetch(`/api/characters/${encodeURIComponent(selected.value.unicode)}/approve`, { method: 'POST' })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? '승인 실패: 작업 데이터를 확인하세요.')
    message.value = '작업 데이터를 승인해 strokes로 옮겼습니다.'
    await reload()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '승인 실패: 서버 상태를 확인하세요.'
  } finally {
    busy.value = false
  }
}

async function importSvg(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!selected.value || !file) return
  busy.value = true
  error.value = ''
  try {
    const response = await fetch(`/api/characters/${encodeURIComponent(selected.value.unicode)}/import-svg`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ svg: await file.text() }),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? 'SVG 가져오기 실패: AnimCJK 형식 SVG인지 확인하세요.')
    message.value = 'SVG를 작업 데이터로 가져왔습니다. 확인 후 승인하세요.'
    await reload()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'SVG 가져오기 실패: 서버 상태를 확인하세요.'
  } finally {
    busy.value = false
  }
}

async function applyNaver() {
  if (!selected.value) return
  if (strokes.value.length > 0) {
    const confirmed = await askConfirm()
    if (!confirmed) return
  }
  busy.value = true
  error.value = ''
  try {
    const response = await fetch(`/api/characters/${encodeURIComponent(selected.value.unicode)}/apply-naver`, { method: 'POST' })
    const body = await response.json()
    if (!response.ok) throw new Error(body.error ?? '네이버 획순 적용 실패: 잠시 후 다시 시도하세요.')
    message.value = '네이버 한자사전 획순을 적용했습니다.'
    await reload()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '네이버 획순 적용 실패: 네트워크 상태를 확인하세요.'
  } finally {
    busy.value = false
  }
}

async function undo() {
  if (!selected.value) return
  const response = await fetch(`/api/characters/${encodeURIComponent(selected.value.unicode)}/undo`, { method: 'POST' })
  const body = await response.json()
  if (!response.ok) {
    error.value = body.error ?? '되돌리기 실패: 이전 편집 이력이 없습니다.'
    return
  }
  selected.value = body
  strokes.value = body.strokes
  shown.value = strokes.value.length
  message.value = '이전 편집 상태로 복원 완료'
}

async function compileChar() {
  if (!selected.value) return
  const response = await fetch(`/api/characters/${encodeURIComponent(selected.value.unicode)}/compile`, { method: 'POST' })
  const body = await response.json()
  if (!response.ok) {
    error.value = body.error ?? '컴파일 실패: 획 데이터 유효성을 확인하세요.'
    await reload()
    return
  }
  message.value = '배포용 컴파일 JSON 생성 완료'
  await reload()
}

async function syncMissing() {
  busy.value = true
  error.value = ''
  try {
    const response = await fetch('/api/sync-missing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: MISSING_FETCH_LIMIT }),
    })
    const body = await response.json()
    message.value = `미완료 한자 ${body.tried}자 레퍼런스 조회 완료`
    await loadList()
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '일괄 레퍼런스 조회 실패: 네트워크 상태를 확인하세요.'
  } finally {
    busy.value = false
  }
}

function moveStroke(index: number, delta: number) {
  const next = index + delta
  if (next < 0 || next >= strokes.value.length) return
  const copy = strokes.value.slice()
  const [item] = copy.splice(index, 1)
  copy.splice(next, 0, item)
  strokes.value = copy.map((stroke, order) => ({ ...stroke, stroke_order: order + 1 }))
}

function setCap(index: number, end: 'start' | 'end', value: CapType) {
  const stroke = strokes.value[index]
  if (end === 'start') stroke.start_cap_type = value
  else stroke.end_cap_type = value
}

function lengthOf(points: Pt[]): number {
  let length = 0
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1])
  }
  return length
}

function dashOf(stroke: StrokeRecord, index: number) {
  const length = lengthOf(stroke.median_points)
  const span = length + stroke.stroke_width
  const amount = index < shown.value - 1 ? 0 : index === shown.value - 1 ? span * (1 - reveal.value) : span
  return { array: span, offset: amount }
}

function pointsOf(points: Pt[]): string {
  return points.map((point) => point.join(',')).join(' ')
}

function play() {
  stop()
  if (strokes.value.length === 0) return
  if (reducedMotion.value) {
    showAll()
    return
  }
  playing.value = true
  shown.value = 1
  reveal.value = 0
  lastTimestamp = 0

  const step = (timestamp: number) => {
    if (!playing.value) return
    if (!lastTimestamp) lastTimestamp = timestamp
    const elapsed = timestamp - lastTimestamp

    // Smooth animation step based on elapsed time (~350ms per stroke)
    const stepIncrement = elapsed > 0 ? elapsed / 350 : REVEAL_STEP
    lastTimestamp = timestamp

    reveal.value = Math.min(1, reveal.value + stepIncrement)
    if (reveal.value >= 1) {
      reveal.value = 1
      if (shown.value >= strokes.value.length) {
        playing.value = false
        animFrameId = 0
        return
      }
      shown.value += 1
      reveal.value = 0
      lastTimestamp = timestamp
    }
    animFrameId = window.requestAnimationFrame(step)
  }
  animFrameId = window.requestAnimationFrame(step)
}

function stop() {
  if (animFrameId) {
    window.cancelAnimationFrame(animFrameId)
    animFrameId = 0
  }
  playing.value = false
}

function showAll() {
  stop()
  shown.value = strokes.value.length
  reveal.value = 1
}

function eventToFont(event: PointerEvent): Pt | null {
  const node = layer.value
  const ctm = node?.getScreenCTM()
  if (!ctm) return null
  const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse())
  return [point.x, point.y]
}

function onPointerDown(event: PointerEvent) {
  const point = eventToFont(event)
  if (!point || shown.value === 0) return
  const stroke = strokes.value[shown.value - 1]
  if (!stroke) return
  if (!knifeFrom.value) {
    knifeFrom.value = point
    message.value = '획 분할: 자를 끝점을 클릭하세요.'
    return
  }
  const parts = splitStrokeByKnife(stroke.outline_path, { x: knifeFrom.value[0], y: knifeFrom.value[1] }, { x: point[0], y: point[1] })
  knifeFrom.value = null
  if (!parts) {
    error.value = '획 분할 불가: 외곽선과 교차하도록 두 점을 지정하세요.'
    return
  }
  const [left, right] = parts.map((path) => {
    const median = recoverMedian(path, stroke.stroke_width)
    const points = median.median.map((p) => [p.x, p.y] as Pt)
    return {
      ...stroke,
      outline_path: path,
      median_points: points.length >= 2 ? points : stroke.median_points,
      stroke_width: median.width,
    }
  })
  strokes.value.splice(shown.value - 1, 1, left, right)
  strokes.value = strokes.value.map((item, order) => ({ ...item, stroke_order: order + 1 }))
  shown.value += 1
  message.value = '획 분할 완료. [변경사항 저장]을 누르면 반영됩니다.'
}

onMounted(() => {
  try {
    const saved = localStorage.getItem('color-scheme')
    if (saved === 'dark' || saved === 'light') {
      themeMode.value = saved
    } else {
      themeMode.value = 'system'
    }
  } catch {}
  window.addEventListener('storage', handleStorageChange)
  loadList()
})

onBeforeUnmount(() => {
  stop()
  if (listAbortController) listAbortController.abort()
  if (motionMedia) {
    motionMedia.removeEventListener('change', onMotionPreferenceChange)
  }
  window.removeEventListener('storage', handleStorageChange)
})
</script>

<template>
  <a href="#main-content" class="skip-link visually-hidden">본문으로 건너뛰기</a>
  <div class="app">
    <aside class="side" aria-label="한자 탐색">
      <header class="side-header">
        <div class="brand-row">
          <h1>추사 1817</h1>
          <div class="theme-switch" role="group" aria-label="화면 테마">
            <button
              type="button"
              class="theme-btn"
              :class="{ active: themeMode === 'system' }"
              :aria-pressed="themeMode === 'system'"
              title="시스템 테마 연동"
              @click="setTheme('system')"
            >
              <span aria-hidden="true">💻</span>
              <span class="visually-hidden">시스템 테마</span>
            </button>
            <button
              type="button"
              class="theme-btn"
              :class="{ active: themeMode === 'light' }"
              :aria-pressed="themeMode === 'light'"
              title="라이트 모드"
              @click="setTheme('light')"
            >
              <span aria-hidden="true">☀️</span>
              <span class="visually-hidden">라이트 모드</span>
            </button>
            <button
              type="button"
              class="theme-btn"
              :class="{ active: themeMode === 'dark' }"
              :aria-pressed="themeMode === 'dark'"
              title="다크 모드"
              @click="setTheme('dark')"
            >
              <span aria-hidden="true">🌙</span>
              <span class="visually-hidden">다크 모드</span>
            </button>
          </div>
        </div>
        <div class="search-box">
          <label for="char-search" class="visually-hidden">한자, 독음, 유니코드 검색</label>
          <input
            id="char-search"
            v-model="query"
            type="search"
            class="search"
            placeholder="한자, 독음, 코드 검색"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            enterkeyhint="search"
            @input="loadList"
            @keydown="onSearchKeyDown"
          />
        </div>
      </header>

      <nav class="chars" aria-label="한자 목록">
        <div v-if="!query && chars.length === 0" class="upload-box">
          <label for="initial-file-upload" class="empty">
            등록된 한자가 없습니다. 한자 목록 JSON 파일을 업로드하세요.
          </label>
          <input
            id="initial-file-upload"
            type="file"
            accept="application/json,.json"
            @change="uploadInitial"
          />
        </div>
        <ul v-else class="char-list" role="list">
          <li v-for="row in chars" :key="row.unicode">
            <button
              class="char"
              :class="{ active: selected?.unicode === row.unicode }"
              :aria-current="selected?.unicode === row.unicode ? 'true' : undefined"
              @click="openChar(row)"
            >
              <span class="glyph" lang="zh-Hani">{{ row.char }}</span>
              <span class="meta">
                <span>{{ row.reading }}</span>
                <span>{{ row.unicode }}</span>
              </span>
              <span class="badge">
                {{ row.stroke_count }}획
              </span>
            </button>
          </li>
        </ul>
      </nav>
    </aside>

    <main id="main-content" class="main" tabindex="-1">
      <section class="stage-wrap" aria-labelledby="viewer-heading">
        <h2 id="viewer-heading" class="visually-hidden">획 뷰어</h2>
        <div class="stage">
          <svg
            v-if="selected"
            role="img"
            :aria-label="`${selected.char} (${selected.reading ?? ''}) ${selected.stroke_count}획 필순 뷰어`"
            :viewBox="`0 0 ${CANVAS} ${CANVAS}`"
            tabindex="0"
            @pointerdown="onPointerDown"
          >
            <title>{{ selected.char }} {{ selected.reading ? `(${selected.reading})` : '' }} 획 외곽선 및 중심선</title>
            <g ref="layer" :transform="`translate(0 ${CANVAS}) scale(1 -1)`">
              <path v-if="background === 'outline'" class="guide-outline" :d="fullOutline" />
              <path v-else-if="background === 'silhouette'" class="guide-silhouette" :d="fullOutline" />
              <path
                v-for="stroke in visibleStrokes"
                :key="`${stroke.stroke_order}-fill`"
                class="ink-stroke"
                :class="{ 'radical-stroke': stroke.is_radical }"
                :d="stroke.outline_path"
              />
              <clipPath
                v-for="stroke in visibleStrokes"
                :id="`clip-${stroke.stroke_order}`"
                :key="`clip-${stroke.stroke_order}`"
              >
                <path :d="stroke.outline_path" />
              </clipPath>
              <polyline
                v-for="(stroke, index) in visibleStrokes"
                :key="`${stroke.stroke_order}-anim`"
                :clip-path="`url(#clip-${stroke.stroke_order})`"
                class="anim-stroke"
                :class="{ radical: stroke.is_radical }"
                :points="pointsOf(stroke.median_points)"
                :stroke-width="stroke.stroke_width"
                :stroke-dasharray="dashOf(stroke, index).array"
                :stroke-dashoffset="dashOf(stroke, index).offset"
              />
              <polyline
                v-for="stroke in visibleStrokes"
                v-show="showMedians"
                :key="`${stroke.stroke_order}-median`"
                class="median-stroke"
                :points="pointsOf(stroke.median_points)"
              />
              <g
                v-for="(stroke, index) in visibleStrokes"
                v-show="showNumbers"
                :key="`${stroke.stroke_order}-no`"
                :transform="`translate(${stroke.median_points[0][0]} ${stroke.median_points[0][1]}) scale(1 -1)`"
              >
                <circle :r="BADGE_RADIUS" class="num-badge" />
                <text text-anchor="middle" dominant-baseline="central">{{ index + 1 }}</text>
              </g>
            </g>
          </svg>
          <p v-else class="empty">편집할 한자를 왼쪽 목록에서 선택하세요.</p>

          <div class="step-row" role="toolbar" aria-label="필순 탐색 도구">
            <button
              :disabled="!selected || shown <= 1"
              aria-label="이전 획"
              @click="shown = Math.max(1, shown - 1); reveal = 1"
            >
              이전 획
            </button>
            <strong aria-live="polite" aria-atomic="true">{{ shown }} / {{ strokes.length }}</strong>
            <button
              :disabled="!selected || shown >= strokes.length"
              aria-label="다음 획"
              @click="shown = Math.min(strokes.length, shown + 1); reveal = 1"
            >
              다음 획
            </button>
            <button :disabled="!selected" @click="showAll">전체 보기</button>
            <button
              class="primary"
              :disabled="!selected || playing"
              :aria-label="playing ? '재생 중' : '필순 재생'"
              @click="play"
            >
              {{ playing ? '재생 중…' : '필순 재생' }}
            </button>
          </div>

          <div class="mode-row" role="group" aria-label="표시 설정">
            <button
              :class="{ on: background === 'outline' }"
              :aria-pressed="background === 'outline'"
              @click="background = 'outline'"
            >
              외곽선
            </button>
            <button
              :class="{ on: background === 'silhouette' }"
              :aria-pressed="background === 'silhouette'"
              @click="background = 'silhouette'"
            >
              실루엣
            </button>
            <button
              :class="{ on: background === 'none' }"
              :aria-pressed="background === 'none'"
              @click="background = 'none'"
            >
              배경 없음
            </button>
            <button
              :class="{ on: showMedians }"
              :aria-pressed="showMedians"
              @click="showMedians = !showMedians"
            >
              중심선 표시
            </button>
            <button
              :class="{ on: showNumbers }"
              :aria-pressed="showNumbers"
              @click="showNumbers = !showNumbers"
            >
              번호 표시
            </button>
          </div>
        </div>

        <p class="hint" aria-live="polite" aria-atomic="true">{{ message }}</p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
      </section>

      <section class="panel" aria-labelledby="panel-heading">
        <h2 id="panel-heading" class="visually-hidden">획 관리 및 편집 패널</h2>
        <div class="actions" role="toolbar" aria-label="데이터 관리 도구">
          <button :disabled="!selected || busy" @click="pullReference">레퍼런스 수신</button>
          <button :disabled="busy" @click="syncMissing">미완료 20자 동기화</button>
          <button class="primary" :disabled="!selected || busy" @click="saveStrokes('획 편집')">변경사항 저장</button>
          <button class="primary" :disabled="!selected?.working || strokes.length === 0 || busy" @click="approve">승인</button>
          <input ref="svgFileInput" class="visually-hidden" tabindex="-1" aria-hidden="true" type="file" accept="image/svg+xml,.svg" @change="importSvg" />
          <button :disabled="!selected || busy || (strokes.length > 0 && !selected.working)" @click="svgFileInput?.click()">SVG 가져오기</button>
          <button :disabled="!selected || busy" @click="applyNaver">네이버 획순 적용</button>
          <button :disabled="!selected" @click="undo">실행 취소</button>
          <button :disabled="!selected" @click="compileChar">JSON 컴파일</button>
        </div>
        <p class="hint">획 위의 두 점을 순서대로 클릭하면 획이 분할됩니다. 부수 획은 붉은색 점선으로 강조됩니다.</p>
        <ul class="type-list" role="list" aria-label="획 상세 목록">
          <li v-for="(stroke, index) in strokes" :key="stroke.stroke_order" class="stroke-item">
            <span class="stroke-num">{{ index + 1 }}획</span>
            <label class="check-label">
              <input v-model="stroke.is_radical" type="checkbox" :true-value="1" :false-value="0" />
              <span>부수</span>
            </label>
            <label class="select-label">
              <span class="visually-hidden">{{ index + 1 }}획 시작 캡</span>
              <select
                :value="stroke.start_cap_type"
                :aria-label="`${index + 1}획 시작 캡`"
                @change="setCap(index, 'start', ($event.target as HTMLSelectElement).value as CapType)"
              >
                <option value="NONE">시작 없음</option>
                <option value="AUTO_ROUND">시작 둥글게</option>
                <option value="REF_STAMP">시작 도장</option>
              </select>
            </label>
            <label class="select-label">
              <span class="visually-hidden">{{ index + 1 }}획 끝 캡</span>
              <select
                :value="stroke.end_cap_type"
                :aria-label="`${index + 1}획 끝 캡`"
                @change="setCap(index, 'end', ($event.target as HTMLSelectElement).value as CapType)"
              >
                <option value="NONE">끝 없음</option>
                <option value="AUTO_ROUND">끝 둥글게</option>
                <option value="REF_STAMP">끝 도장</option>
              </select>
            </label>
            <div class="stroke-order-btns" role="group" :aria-label="`${index + 1}획 순서 조정`">
              <button
                :disabled="index === 0"
                :aria-label="`${index + 1}획 순서 위로 이동`"
                @click="moveStroke(index, -1)"
              >
                위로
              </button>
              <button
                :disabled="index === strokes.length - 1"
                :aria-label="`${index + 1}획 순서 아래로 이동`"
                @click="moveStroke(index, 1)"
              >
                아래로
              </button>
            </div>
          </li>
        </ul>
      </section>
    </main>

    <dialog
      ref="confirmDialog"
      class="app-dialog"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-desc"
      @close="onConfirmClose"
    >
      <div class="dialog-content">
        <h3 id="confirm-dialog-title">네이버 획순 적용</h3>
        <p id="confirm-dialog-desc">
          현재 획 데이터를 네이버 한자사전 획순으로 바꿉니다.<br />
          바뀐 뒤에도 실행 취소로 되돌릴 수 있습니다.
        </p>
        <form method="dialog" class="dialog-actions">
          <button type="submit" value="cancel" autofocus>취소</button>
          <button type="submit" value="confirm" class="primary">적용하기</button>
        </form>
      </div>
    </dialog>
  </div>
</template>
