const PERCENT = 100

// 불투명도 슬라이더: 0~100%를 5% 단위로 움직인다.
export const OPACITY_SLIDER = { min: 0, max: PERCENT, step: 5 } as const

// 0~1 비율을 정수 퍼센트로, 퍼센트를 비율로 바꾼다.
export const toPercent = (ratio: number): number => Math.round(ratio * PERCENT)
export const fromPercent = (percent: number): number => percent / PERCENT
