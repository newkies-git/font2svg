import type { Workspace } from './workspace.ts'

type RouteContext = {
  ws: Workspace
  // 경로의 :이름 구간 값(URL 디코딩됨)
  params: Record<string, string>
  searchParams: URLSearchParams
  body: () => Promise<Record<string, unknown>>
}

export type Route = {
  method: string
  // '/' 로 구분한 구간. ':이름'은 값을 받는 구간이고, 이름이 unicode면 U+로 시작해야 한다.
  pattern: string
  handler: (context: RouteContext) => unknown | Promise<unknown>
}

// 문자열이고 비어 있지 않을 때만 값으로 본다.
export const optionalText = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
