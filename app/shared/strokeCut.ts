// 윤곽 래스터화·골격·중심선 복원·분할 알고리즘의 공개 진입점. 구현은 strokeCut/ 아래 모듈에 있다.
//   raster   윤곽 → 격자, 격자 ↔ 글꼴 좌표
//   skeleton Zhang-Suen 세선화, 가지치기, 골격 선분 분해
//   contour  마스크의 바깥 윤곽 추적과 단순화
//   median   중심선·획 폭 복원
//   knife    칼 분할(겹침 포함)
//   caps     기필·수필 모양
//   extract  획 추출(교차 분리)
//   segment  중심선 기준 윤곽 분할
//   overlap  접합부 끝단 겹침 폭 측정·확장
//   bridge   교차로 끊긴 외곽선 끝점을 베지어로 연결
export { spliceOutlineBridge } from './strokeCut/bridge.ts'
export { simplifyPolyline } from './strokeCut/contour.ts'
export { applyCapAtFace, applyCapShape, capLength, isCapShape, matchMedianEnd, type CapShape } from './strokeCut/caps.ts'
export { extractStrokeAlongGuide } from './strokeCut/extract.ts'
export { KNIFE_OVERLAP, splitStrokeByKnife } from './strokeCut/knife.ts'
export { computeOptimalStrokeWidth, recoverMedian } from './strokeCut/median.ts'
export { segmentOutlineByMedians } from './strokeCut/segment.ts'
export { zhangSuen } from './strokeCut/skeleton.ts'
