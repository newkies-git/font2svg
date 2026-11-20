// 캔버스 오버레이의 크기(글꼴 좌표 단위). 핸들·점이 화면에서 잡기 쉬운 크기로 정한 값이다.

// 선택·변환 핸들: 한 변 길이. 회전 모드에서는 이 절반을 모서리 반경으로 써 원이 된다.
export const TRANSFORM_HANDLE_SIZE = 14

// 베지어 편집: 제어점 반지름, 앵커 한 변 길이
export const BEZIER_CONTROL_RADIUS = 5
export const BEZIER_ANCHOR_SIZE = 10

// 중심선·윤곽 연결 정점의 반지름: 끝점(기필·수필, 시작·끝)은 가운데 점보다 크게 그린다.
export const MEDIAN_END_RADIUS = 12
export const MEDIAN_MID_RADIUS = 9
export const CONNECT_END_RADIUS = 11
export const CONNECT_MID_RADIUS = 8

// 칼 선: 첫 점의 맥박 원과 점 반지름
export const KNIFE_PULSE_RADIUS = 14
export const KNIFE_POINT_RADIUS = 5

// 돋보기: 십자선의 반 길이와, 커서 위 고리의 반지름
export const LOUPE_CROSS_HALF = 16
export const LOUPE_FOCUS_RADIUS = 5
