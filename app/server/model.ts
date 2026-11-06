import type { Pt } from '../src/types.ts'

export type { Pt }

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
export const ORIGIN_MANUAL = 'MANUAL'

export type StrokeOutline = { order: number; path: string; radical: 0 | 1 }
export type MedianLine = { order: number; points: Pt[]; width: number; start_cap: string; end_cap: string }

export type StrokeItem = {
  outline_path: string
  median_points: Pt[]
  stroke_width: number
  is_radical: number
  start_cap_type: string
  end_cap_type: string
}
