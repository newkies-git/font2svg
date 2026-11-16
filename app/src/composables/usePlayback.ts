import { onBeforeUnmount, ref, type Ref } from 'vue'
import { REVEAL_STEP, REVEAL_STROKE_MS } from '../lib/constants.ts'

// requestAnimationFrame 기반 필순 재생. shown/reveal은 뷰어와 공유하는 상태다.
export function usePlayback(strokeCount: () => number, shown: Ref<number>, reveal: Ref<number>) {
  const playing = ref(false)
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

  function stop() {
    if (animFrameId) {
      window.cancelAnimationFrame(animFrameId)
      animFrameId = 0
    }
    playing.value = false
  }

  function showAll() {
    stop()
    shown.value = strokeCount()
    reveal.value = 1
  }

  function play() {
    stop()
    if (strokeCount() === 0) return
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

      // 경과 시간에 비례해 부드럽게 진행한다(한 획 REVEAL_STROKE_MS)
      const stepIncrement = elapsed > 0 ? elapsed / REVEAL_STROKE_MS : REVEAL_STEP
      lastTimestamp = timestamp

      reveal.value = Math.min(1, reveal.value + stepIncrement)
      if (reveal.value >= 1) {
        reveal.value = 1
        if (shown.value >= strokeCount()) {
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

  onBeforeUnmount(() => {
    stop()
    if (motionMedia) {
      motionMedia.removeEventListener('change', onMotionPreferenceChange)
    }
  })

  return { playing, play, stop, showAll }
}
