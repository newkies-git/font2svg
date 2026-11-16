import { CAP_TYPES } from '../../shared/constants.ts'
import type { CapType } from '../../shared/types.ts'

// 기필/수필 모양 선택 목록의 이름. 순서는 CAP_TYPES를 따른다.
const CAP_LABELS: Record<CapType, string> = {
  NONE: '기본',
  AUTO_ROUND: '둥글게',
  POINTED: '뾰족하게',
  BULGE: '눌러서(부풀림)',
  TAPER: '길게 빼기',
  REF_STAMP: '도장',
  MANUAL: '직접 그리기',
}

export const CAP_OPTIONS = CAP_TYPES.map((value) => ({ value, label: CAP_LABELS[value] }))
