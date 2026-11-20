export const CANVAS = 1024
// 기본 레이어 id. 서버(BUILTIN_LAYERS)와 화면이 같은 값을 쓴다.
export const LAYER_ID = {
  font: 'font',
  outline: 'outline',
  mmh: 'mmh',
  acjk: 'acjk',
  naver: 'naver',
  strokes: 'strokes',
  medians: 'medians',
  numbers: 'numbers',
} as const
export const DEFAULT_STROKE_WIDTH = 135
// 획의 기필(시작)·수필(끝) 모양. 앞의 NONE은 모양을 붙이지 않은 기본, REF_STAMP는 레퍼런스 도장, MANUAL은 사람이 직접 그린 모양이다.
export const CAP_TYPES = ['NONE', 'AUTO_ROUND', 'POINTED', 'BULGE', 'TAPER', 'REF_STAMP', 'MANUAL'] as const
export const MIN_STROKE_WIDTH = 40
export const STROKE_WIDTH_CAP_RATIO = 2.5
export const STROKE_WIDTH_MARGIN = 14
export const COORD_ROUND = 10
// 투명도는 소수 둘째 자리(1/OPACITY_STEPS 단위)로 반올림한다.
export const OPACITY_STEPS = 100
// 재생: 한 획이 드러나는 데 걸리는 시간(ms)
export const REVEAL_STROKE_MS = 350
// 레이어 표시 메타(눈·투명도·잠금 등) 변경을 모아 서버로 보내기 전 대기 시간(ms)
export const META_PATCH_DEBOUNCE_MS = 180
export const COORD_DECIMALS = 1
export const UNICODE_HEX_PAD = 4
export const SHA256_HEX_LENGTH = 64
export const KANGXI_COUNT = 214
export const DB_BUSY_TIMEOUT_MS = 5_000
export const FETCH_TIMEOUT_MS = 10_000
export const OLLAMA_TIMEOUT_MS = 60_000
// 로컬 Ollama 채팅: 한 번에 보내는 대화 수·메시지 길이·컨텍스트 획 수 상한, 응답 다양성(temperature)
export const OLLAMA_CHAT_MAX_MESSAGES = 20
export const OLLAMA_CHAT_MAX_CONTENT = 4000
export const OLLAMA_CHAT_MAX_STROKES = 64
export const OLLAMA_CHAT_TEMPERATURE = 0.3
// 채팅 한 번의 응답에서 받아들이는 데이터 수정 제안의 최대 개수
export const OLLAMA_CHAT_MAX_EDITS = 16
export const MEDIAN_MIN_POINTS = 2
export const MEDIAN_BBOX_INSET = 20
export const MEDIAN_SIMPLIFY_TOLERANCE = 3
export const MIN_STROKE_AREA_RATIO = 0.005
export const MIN_COVERED_AREA_RATIO = 0.85
// 새 사용자(CUSTOM) 레이어의 기본 불투명도
export const DEFAULT_CUSTOM_LAYER_OPACITY = 0.85
export const MAX_COVERED_AREA_RATIO = 1.7
export const FONT_BATCH_LIMIT = 10
export const AREA_FLATNESS = 2
export const IDS_MAX_DEPTH = 3
export const ACJK_FILE_LIMIT = 32 * 1024 * 1024
export const ACJK_BATCH_LIMIT = 200
// OUTLINE 매핑: 획 윤곽의 꼭짓점이 궁서체 윤곽선에서 이 거리 이내면 그 윤곽에 속한 것으로 본다.
export const OUTLINE_CONTOUR_TOLERANCE = 6
// 획 윤곽 꼭짓점 중 이 비율 이상이 한 궁서체 윤곽 위에 있으면 그 윤곽에 매핑한다.
export const OUTLINE_CONTOUR_MATCH_RATIO = 0.1
// 궁서체 윤곽 지문(해시) 길이(16진수 글자 수). 매핑이 만들어진 뒤 윤곽이 바뀌었는지 알아보는 데 쓴다.
export const FONT_FINGERPRINT_LENGTH = 12
export const ANIM_PATH_LENGTH = 3333
export const ANIM_STROKE_SECONDS = 0.8
export const ANIM_STROKE_STEP_SECONDS = 1
// AnimCJK SVG의 y는 아래로 늘어난다: graphics 좌표 y = ACJK_SVG_Y_ORIGIN - SVG y (makeGraphicsFromSvgs.php와 같다).
export const ACJK_SVG_Y_ORIGIN = 900
// Shift+방향키로 선택한 획을 옮기는 거리(저장 좌표 단위)
export const NUDGE_STEP = 2
export const BADGE_RADIUS = 28
export const REVEAL_STEP = 0.04
// 자동 맞춤: 래스터 격자(칸 수), 격자가 덮는 좌표 범위의 여백, 윤곽 평탄화 허용 오차
export const FIT_GRID = 256
export const FIT_MARGIN = 128
export const FIT_FLATNESS = 2
// 자동 맞춤 탐색: 단계 수와 단계별 줄이는 비율, 한 단계의 최대 반복, 개선으로 인정하는 최소 IoU 증가량
export const FIT_LEVELS = 6
export const FIT_STEP_DECAY = 0.5
export const FIT_MAX_SWEEPS = 6
export const FIT_MIN_GAIN = 1e-4
// 자동 맞춤 첫 단계 보폭: 이동(좌표), 배율, 회전(라디안), 기울임
export const FIT_STEP_SHIFT = 24
export const FIT_STEP_SCALE = 0.08
export const FIT_STEP_ANGLE = 0.1
export const FIT_STEP_SHEAR = 0.1
// 자동 맞춤이 허용하는 변형 한계(초기 위치 기준): 이동, 배율 범위, 회전, 기울임
export const FIT_LIMIT_SHIFT = 160
export const FIT_LIMIT_SCALE = 0.5
export const FIT_LIMIT_ANGLE = 0.5
export const FIT_LIMIT_SHEAR = 0.5
// 자동 맞춤 시 다른 획과 만나는 획의 시작·끝이 겹치는 상대 획 폭 대비 겹침 비율 범위(1/2 ~ 2/3)
export const FIT_END_OVERLAP_MIN_RATIO = 0.5
export const FIT_END_OVERLAP_MAX_RATIO = 2 / 3
// 자동 맞춤 시 윤곽의 꺾임(모서리)으로 보는 방향 전환 각도(라디안). 분할 조각이 원본 획보다 꺾임이 많으면 원본 윤곽을 변형해 맞춘다.
export const FIT_CORNER_ANGLE = Math.PI / 4
// DB 백업 파일 이름 접두어(database/<DB 이름>.backup-<시각>.db). .gitignore가 이 패턴을 제외한다.
export const BACKUP_TAG = 'backup'
// 마이그레이션 직전 자동 백업 파일 이름 접두어(database/<DB 이름>.before-v<버전>-<시각>.db)
export const PRE_MIGRATION_TAG = 'before'
// 한 번에 저장할 수 있는 레이어 수 상한(기본 8개 + 사용자 복제 레이어를 넉넉히 덮는 값)
export const LAYER_BATCH_LIMIT = 64
// API 요청 본문 상한(바이트). 레이어 저장·초기 글자 목록 업로드가 충분히 들어가는 크기
export const API_BODY_LIMIT_BYTES = 8 * 1024 * 1024
// warnOnce가 한 프로세스(또는 페이지)에서 기록하는 서로 다른 경고의 최대 개수. 넘으면 더 기록하지 않는다.
export const WARN_ONCE_LIMIT = 100
// 이미지 가져오기(래스터 이미지 → 획 SVG)
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const
// 화면이 읽을 수 있는 원본 이미지 파일 크기 상한(바이트)
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024
// 이진화 전에 긴 변을 이 크기(픽셀) 이하로 줄인다. 윤곽 추적 비용과 잡음을 함께 줄인다.
export const IMAGE_MAX_SIDE = 640
// 글자를 저장 좌표계(CANVAS)에 놓을 때 사방 여백
export const IMAGE_FIT_MARGIN = 64
// 윤곽 추적이 가장자리에서 끊기지 않도록 마스크에 두르는 빈 테두리(픽셀)
export const IMAGE_MASK_PAD = 16
// 전체 잉크 픽셀 대비 이 비율보다 작은 덩어리는 먼지·잡음으로 보고 버린다.
export const IMAGE_MIN_COMPONENT_RATIO = 0.005
// 한 글자로 받아들이는 덩어리(윤곽)의 최대 개수. 넘으면 이진화가 잘못된 것으로 본다.
export const IMAGE_MAX_COMPONENTS = 24
// 흑백 변환(ITU-R BT.601 휘도 가중치)과 투명 배경을 깔 흰색 값
export const LUMA_RED = 0.299
export const LUMA_GREEN = 0.587
export const LUMA_BLUE = 0.114
export const GRAY_MAX = 255
export const GRAY_LEVELS = GRAY_MAX + 1
// 잉크가 이 비율을 넘으면 배경이 어둡다고 보고 반전한다.
export const IMAGE_INVERT_RATIO = 0.5
export const IMAGE_NAME_MAX_LENGTH = 255
export const IMAGE_SIDE_MAX = 100_000
// 이미지 윤곽을 획으로 나누는 방식: AUTO는 길잡이 중심선(2획 이상)이 있으면 그것으로 나누고, COMPONENTS는 이어진 덩어리 하나를 획 하나로 본다.
export const IMAGE_SPLITS = ['AUTO', 'COMPONENTS'] as const
export type ImageSplit = (typeof IMAGE_SPLITS)[number]
