import type { WriteMode } from './types.ts'

// 요청 값에서 반영 방식을 읽는다. 'append'가 아니면 모두 교체로 본다.
export const parseWriteMode = (value: unknown): WriteMode => (value === 'append' ? 'append' : 'replace')
