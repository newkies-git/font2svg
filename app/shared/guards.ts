// 배열이 아닌 일반 객체인지 확인한다.
export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
