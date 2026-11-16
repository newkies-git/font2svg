import { WARN_ONCE_LIMIT } from './constants.ts'

const seen = new Set<string>()
let limitNoticed = false

// 같은 범위(scope)·같은 메시지의 경고는 한 번만 콘솔에 낸다. 획마다 호출되는 경로가 콘솔을 채우지 않게 한다.
export function warnOnce(scope: string, cause: unknown): void {
  const detail = cause instanceof Error ? cause.message : String(cause)
  const key = `${scope}|${detail}`
  if (seen.has(key)) return
  if (seen.size >= WARN_ONCE_LIMIT) {
    if (!limitNoticed) {
      limitNoticed = true
      console.warn(`[log] 서로 다른 경고가 ${WARN_ONCE_LIMIT}개를 넘어 이후 경고는 기록하지 않습니다.`)
    }
    return
  }
  seen.add(key)
  console.warn(`[${scope}] ${detail}`)
}

// 시험용: 기록된 경고를 비운다.
export function resetWarnings(): void {
  seen.clear()
  limitNoticed = false
}
