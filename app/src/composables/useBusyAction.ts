import type { Ref } from 'vue'

// busy 표시와 오류 메시지 처리를 한곳에 모은다: 시작 시 error를 비우고 busy를 켜며,
// 던져진 오류는 error에 담고(메시지가 없으면 fallback), 끝나면 busy를 끈다.
export function createBusyRunner(busy: Ref<boolean>, error: Ref<string>) {
  return async function run(task: () => Promise<void>, fallbackError: string): Promise<void> {
    error.value = ''
    busy.value = true
    try {
      await task()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : fallbackError
    } finally {
      busy.value = false
    }
  }
}
