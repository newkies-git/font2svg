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
export const MISSING_FETCH_LIMIT = 20
export const MEDIAN_MIN_POINTS = 2
export const MEDIAN_BBOX_INSET = 20
export const MEDIAN_SIMPLIFY_TOLERANCE = 3
export const MIN_STROKE_AREA_RATIO = 0.005
export const MIN_COVERED_AREA_RATIO = 0.85
export const MAX_COVERED_AREA_RATIO = 1.7
export const FONT_BATCH_LIMIT = 10
export const AREA_FLATNESS = 2
export const IDS_MAX_DEPTH = 3
export const IDS_FILE_LIMIT = 16 * 1024 * 1024
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
// 획별 보정을 영역 재할당과 번갈아 반복하는 횟수
export const FIT_REFINE_ROUNDS = 2
// DB 백업 파일 이름 접두어(database/<DB 이름>.backup-<시각>.db). .gitignore가 이 패턴을 제외한다.
export const BACKUP_TAG = 'backup'
// 마이그레이션 직전 자동 백업 파일 이름 접두어(database/<DB 이름>.before-v<버전>-<시각>.db)
export const PRE_MIGRATION_TAG = 'before'
// API 요청 본문 상한(바이트). 레이어 저장·초기 글자 목록 업로드가 충분히 들어가는 크기
export const API_BODY_LIMIT_BYTES = 8 * 1024 * 1024
