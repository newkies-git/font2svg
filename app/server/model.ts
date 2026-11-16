import type { CapType, Pt, StrokeRecord } from '../shared/types.ts'

export const ACTOR_USER = 'user'
export const ACTOR_HANJA = 'system:hanja'
export const ACTOR_MIGRATION = 'system:migration'
export const ACTOR_IDS = 'system:ids'
export const ACTOR_FONT = 'system:font'
export const ACTOR_ACJK = 'system:acjk'
export const ACTOR_NAVER = 'system:naver'
export const ACTION_FONT = '궁서체 윤곽으로 교체'
export const ACTION_UNDO = '실행 취소'
export const ACTION_ACJK = 'AnimCJK로 교체'
export const ACTION_NAVER = '네이버 획순 적용'
export const ACTION_APPROVE = '작업 데이터 승인'
export const ACTION_SVG = 'SVG 가져오기'
// 저장된 값이나 외부에서 온 값을 캡 종류로 정규화한다(모르는 값은 기본).
export function normalizeCap(value: unknown): CapType {
  return value === 'AUTO_ROUND' || value === 'REF_STAMP' ? value : 'NONE'
}

export const ORIGIN_MANUAL = 'MANUAL'

export type StrokeOutline = { order: number; path: string; radical: 0 | 1 }
export type MedianLine = { order: number; points: Pt[]; width: number; start_cap: CapType; end_cap: CapType }

// 저장할 획의 내용. 화면과 서버가 같은 정의(StrokeRecord)를 쓰고, 저장에 필요한 필드만 고른다.
export type StrokeItem = Pick<StrokeRecord, 'outline_path' | 'median_points' | 'stroke_width' | 'is_radical' | 'start_cap_type' | 'end_cap_type'>
