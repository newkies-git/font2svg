# [Master PRD] 한자 획 분리 및 필순 애니메이션 데이터 구축 시스템 (Hanja Stroke Master Studio)

## 1. 프로젝트 개요 (Overview)

- **목적**: 궁서체 TTF 폰트 기반의 한자를 대상으로, 오픈소스 데이터와 로컬 LLM(Ollama)을 결합하여 외곽선(SVG)을 획 단위로 분리하고, Clipping/Masking 방식의 필순 애니메이션용 정적 데이터(`compiled_json`)를 생성하는 로컬 웹 어드민(Pre-processor)과 편집·재생 미리보기 시스템 구축. 구현 현황은 §1.3에 있다.
- **핵심 해결 과제**:
  - 통짜 외곽선(Merged Outline) 구조의 TTF 한계를 극복하기 위한 자동 브러시 교집합 분할 및 잔여 조각 흡수 알고리즘 적용.
  - 중/일 오픈소스에 없는 한국 고유 한자 및 정자체의 Ollama IDS 자소 합성 및 획수 자동 추론.
  - 획 교차점 및 숨겨진 기필/수필(시작점·끝점)의 공백 문제 해결.
  - **한국 필순 기준 준수**: 레퍼런스 데이터의 필순은 출처 국가의 기준을 따른다. Make Me a Hanja는 중국 대륙 기준이므로 한국 교육용 필순과 다를 수 있다(예: `必`, `右`, `王`, `火` 계열). 레퍼런스 필순은 초안일 뿐이며 최종 필순은 한국 기준으로 검수한다(§7.3).

### 1.1. 범위 (Scope)

| 구분 | 포함 | 제외 |
| :--- | :--- | :--- |
| 대상 글자 | 대상 한자 리스트에 등록된 글자(1차: 1,817자) | 리스트 밖의 글자, 간체자 |
| 폰트 | 프로젝트당 단일 궁서체 폰트 1종 | 다중 폰트 동시 편집 |
| 산출물 | 글자별 `compiled_json`, 일괄 배포 번들 | 폰트 파일 자체의 재배포 |
| 실행 환경 | 한 컴퓨터에서 도는 로컬 웹 어드민(Vite 개발 서버가 화면과 API를 함께 제공, 로컬 Ollama 포함). 화면 폰트는 로컬 파일을 쓴다 | 클라우드 LLM 호출, 다중 사용자 동시 편집, Electron·Tauri 같은 데스크톱 셸 |

### 1.2. 용어 (Glossary)

- **섬(Island)**: 외곽선 중 서로 닿지 않는 하나의 채움 영역. 안쪽 구멍을 포함할 수 있다.
- **중심선(Median)**: 획의 붓 진행 경로를 나타내는 점 배열. 첫 점이 기필, 마지막 점이 수필이다.
- **잔여 조각(Residue)**: 브러시 교집합 분할 후 어떤 획에도 속하지 않은 외곽선 조각.
- **기필/수필**: 획의 시작점/끝점.

### 1.3. 구현 현황 (코드 기준)

이 문서의 §2 이후는 요구사항과 설계이고, 아래는 현재 코드가 그와 다르거나 아직 하지 않은 부분이다. 각 절에서도 해당 위치에 따로 적었다.

| 구분 | 현재 코드 |
| :--- | :--- |
| 기술 스택 | Vue 3 + Vite 화면, 같은 Vite 서버의 미들웨어가 제공하는 API(`app/server/`), `node:sqlite` DB. Node 24 이상 |
| 도형 연산 | Paper.js·Boolean 연산·Web Worker를 쓰지 않는다. 윤곽을 격자로 옮겨(래스터) 계산한다(§4.2) |
| 스키마 | `PRAGMA user_version = 3`. 레이어 저장용 `character_layers`, 변환 이력용 `conversions` 테이블이 있다(§3) |
| 이미지 가져오기 | PNG·JPEG·WebP 글자 이미지를 윤곽으로 추적해 획으로 나누고 DB에 기록한다(§4.6) |
| 화면 | 레이어 패널과 캔버스(편집 도구 5종), 필순 단계 재생. 독립된 뷰어 화면과 배경 가이드 3단계 토글은 없다(§5) |
| 컴파일 검증 | §7.1의 일부(획 존재·중심선 2점 이상·경로 문법과 `Z` 닫힘)만 한다. §7.2 기하 검증과 획수 대조는 하지 않는다(§7) |
| 레퍼런스 조회 | hanzi-writer-data는 글자마다 jsDelivr에서 받는다. 로컬에 일괄로 내려받아 두지 않는다(§4.5, §8.1) |
| 보안 | API는 loopback 요청만 받는다. CSP 메타 태그는 두지 않았다(§9.4) |

## 2. 시스템 아키텍처 및 데이터 파이프라인

1. **Input Layer**: 궁서체 `.ttf` 파일 + 대상 한자 리스트 + 레퍼런스 DB(Make Me a Hanja) + IDS 데이터(CHISE/BabelStone IDS) + 로컬 Ollama(`qwen3.5:9b`).
2. **AI & Import Engine**: 화면에서 글자 등록 → DB에 데이터가 없으면 레퍼런스 가져오기(Hanja, §4.5) → 없으면 `issues`에 올리고 IDS 조회(공개 IDS 데이터 우선, 없으면 Ollama 추론)·궁서체 윤곽 추출 → 아핀 변환(Affine Transform)을 통한 초기 중심선 합성. 이 결과는 `strokes`가 아니라 작업 데이터(`working_data`)에 두고, 사람이 확인해 승인하면 `strokes`로 옮긴다(§4.5).
3. **Pre-processing Engine (Geometry)**: 좌표 정규화(§2.1) → 윤곽 래스터화 → 픽셀을 가장 가까운 중심선의 획에 배정(브러시 교집합·잔여 조각 흡수에 해당) → 교차부 공유 확장 → 획별 윤곽 추적과 `strokeWidth` 자동 계산 → 끝 모양 보정(§4.3). 구현은 `app/shared/strokeCut/`이다(§4.2).
4. **Admin Editor**: 수동 보정, 칼 분할 편집, 부수 지정, 레이어별 보기, 필순 재생 미리보기(§4.4).
5. **Validation**: 배포 전 자동 검증(§7). 실패 시 `issues`에 사유를 기록(이하 `ISSUE`).
6. **Storage & Output**: 단일 파일 SQLite 3 DB(`database/chusa1817.db`) 관리 및 뷰어용 최적화 JSON 배포.

### 2.1. 좌표계 정규화 (누락 보완)

폰트와 레퍼런스 데이터는 좌표계가 서로 다르므로, 모든 경로와 중심선은 저장 전에 하나의 좌표계로 변환한다.

| 출처 | 원본 좌표계 | 변환 |
| :--- | :--- | :--- |
| TTF | `unitsPerEm`(보통 1000 또는 2048), y축 위쪽, 기준선 0 | `canvas_size / unitsPerEm` 배율, 기준선·descender 보정 |
| Make Me a Hanja | 1024 × 1024, y축 위쪽, y = 900이 상단 기준 | 평행이동 후 y축 정렬 |

- 저장 좌표계는 `0 ≤ x, y ≤ canvas_size`(기본 1024), **y축 위쪽(폰트 기준)**으로 고정하고, 뷰어는 `scale(1, -1)`로 뒤집어 그린다. 이 규약은 `compiled_json.coordinateSystem`에 명시한다(§6).
- 경로 좌표는 소수점 1자리로 반올림해 저장한다(용량과 비교 안정성).

## 3. 데이터베이스 스키마 설계 (SQLite 3 Complete DDL)

> **연결 규칙**: `PRAGMA foreign_keys`는 DB 파일에 저장되지 않고 **연결마다** 켜야 한다. 켜지 않으면 `ON DELETE CASCADE`가 동작하지 않는다. 모든 연결은 열 때마다 아래 PRAGMA를 실행한다. `journal_mode = WAL`은 파일에 유지된다.

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA user_version = 3;  -- 스키마 버전. 마이그레이션 시 증가(§3.2)

-- 1. 프로젝트 메타데이터
CREATE TABLE project_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    project_name TEXT NOT NULL,
    ttf_filename TEXT NOT NULL,
    ttf_sha256 TEXT NOT NULL,            -- 폰트를 처음 읽기 전에는 0 64개. 읽으면 SHA-256(소문자 16진수)을 기록한다
    ttf_units_per_em INTEGER NOT NULL,
    canvas_size INTEGER NOT NULL DEFAULT 1024,
    default_stroke_width INTEGER NOT NULL DEFAULT 135,
    stroke_order_standard TEXT NOT NULL DEFAULT 'KR',  -- 최종 필순 기준
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,     -- UTC
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. 부수(Radicals) 마스터 사전 (강희 214부수 및 변형)
CREATE TABLE radicals (
    id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 214),  -- 강희부수 번호
    radical_char TEXT NOT NULL UNIQUE,
    variant_chars TEXT,                  -- JSON 배열. 예: '["氵","氺"]'
    reading TEXT NOT NULL,               -- 음. 예: '일'
    meaning TEXT NOT NULL,               -- 훈. 예: '한'
    stroke_count INTEGER NOT NULL
);

-- 3. 한자 마스터 테이블
CREATE TABLE characters (
    unicode TEXT PRIMARY KEY,            -- 'U+7553', 'U+2E569' (형식은 코드가 만든다. DB는 검사하지 않는다)
    char TEXT NOT NULL UNIQUE,
    grade TEXT,                          -- 구분: '중등', '고등', '3급' (한문 교육용 기초 한자 1800자 + 3급 17자)

    -- 음훈 정보
    reading TEXT,                        -- 대표 음. 예: '락'
    meaning TEXT,                        -- 대표 훈. 예: '즐길'
    variant_reading JSON NOT NULL DEFAULT '[]'  -- 다른 음 배열. 예: '["악", "요"]'
        CHECK (json_valid(variant_reading) AND json_type(variant_reading) = 'array'),
    variant_meaning JSON NOT NULL DEFAULT '[]'  -- 다른 훈 배열. 예: '["노래", "좋아할"]'
        CHECK (json_valid(variant_meaning) AND json_type(variant_meaning) = 'array'),

    stroke_count INTEGER NOT NULL DEFAULT 0,
    last_modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,   -- UTC
    last_modified_by TEXT NOT NULL       -- 'user', 'system:hanja', 'system:acjk', 'system:ids', 'system:font', 'system:migration'
);

-- 3-1. 문제 테이블: 문제가 있거나 아직 사람이 작업해야 하는 글자(`ISSUE`)와 그 원인. 글자당 최대 1행이다.
--    status : 'OPEN' 작업 전 / 'DRAFT' 작업 데이터가 있어 승인 대기 / 'APPROVED' 승인해 strokes로 옮김(기록으로 남긴다)
--    in_font: 궁서체에 글리프가 있으면 1
CREATE TABLE issues (
    char TEXT PRIMARY KEY REFERENCES characters(char) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DRAFT', 'APPROVED')),
    in_font INTEGER NOT NULL DEFAULT 0 CHECK (in_font IN (0, 1))
);

-- 3-2. 작업 데이터 테이블: Hanja에 없는 글자의 IDS 합성 초안, 궁서체에서 뽑은 윤곽, 수작업 데이터. 글자당 1행.
--    strokes와 같은 모양이지만 획이 없어도 된다. 승인하면 strokes로 옮기고 이 행은 지운다. reference_data(외부 원본 캐시)와는 다르다.
--    source: 'IDS', 'OLLAMA_IDS', 'MANUAL' / 'FONT'는 궁서체 윤곽만 있고 획이 없는 경우(획이 생기면 'MANUAL')
CREATE TABLE working_data (
    char TEXT PRIMARY KEY REFERENCES characters(char) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('IDS', 'OLLAMA_IDS', 'MANUAL', 'FONT')),
    source_url TEXT,
    font_outline JSON NOT NULL CHECK (json_valid(font_outline) AND json_type(font_outline) = 'array'),
    stroke_outlines JSON NOT NULL CHECK (json_valid(stroke_outlines) AND json_type(stroke_outlines) = 'array'),
    median_line JSON NOT NULL
        CHECK (json_valid(median_line) AND json_type(median_line) = 'array' AND json_array_length(median_line) = json_array_length(stroke_outlines)),
    last_modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_modified_by TEXT NOT NULL
);

-- 4. 획(Stroke) 테이블: 글자당 1행. font_outline, stroke_outlines, median_line은 JSON이다.
--    SQLite에는 별도 JSON 타입이 없으므로 JSON 선언 타입 + json_valid CHECK로 검증한다.
--    radical         : 강희부수 번호. 0이면 미지정.
--    font_outline    : 글자 전체 윤곽. SVG Path 문자열의 배열 ('["M ... Z", ...]'). 편집해도 바뀌지 않는다.
--    stroke_outlines : 획별 윤곽. [{ "order": 1, "path": "M ... Z", "radical": 1 }, ...]
--                      order는 1부터 시작하는 필순(§6 JSON 배열 인덱스는 0부터), radical은 부수 획이면 1, 아니면 0.
--    median_line     : 획별 중심선. [{ "order": 1, "points": [[x,y], ...], "width": 135,
--                      "start_cap": "NONE|AUTO_ROUND|POINTED|BULGE|TAPER|REF_STAMP|MANUAL", "end_cap": "..." }, ...]
--                      points는 2점 이상, 개수는 stroke_outlines와 같아야 한다.
CREATE TABLE strokes (
    char TEXT PRIMARY KEY REFERENCES characters(char) ON DELETE CASCADE,
    radical INTEGER NOT NULL DEFAULT 0 CHECK (radical BETWEEN 0 AND 214),
    font_outline JSON NOT NULL CHECK (json_valid(font_outline) AND json_type(font_outline) = 'array'),
    stroke_outlines JSON NOT NULL
        CHECK (json_valid(stroke_outlines) AND json_type(stroke_outlines) = 'array' AND json_array_length(stroke_outlines) >= 1),
    median_line JSON NOT NULL
        CHECK (json_valid(median_line) AND json_type(median_line) = 'array'
               AND json_array_length(median_line) = json_array_length(stroke_outlines)),
    last_modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,   -- UTC
    last_modified_by TEXT NOT NULL,      -- 'user', 'system:hanja', 'system:ids', 'system:migration'
    origin TEXT NOT NULL CHECK (origin IN ('MMH', 'ACJK', 'NAVER', 'IDS', 'OLLAMA_IDS', 'MANUAL', 'NONE')),  -- 획 데이터의 출처. NAVER=네이버 한자사전(한국), ACJK=AnimCJK, IDS=공개 IDS 합성, OLLAMA_IDS=Ollama 합성
    origin_url TEXT                      -- 실제로 가져온 주소. 없으면 NULL
);

-- 5. strokes 변경 이력 (감사 기록 + 실행 취소). strokes가 바뀔 때마다 바뀌기 전 행을 그대로 남기고, 삭제하지 않는다.
CREATE TABLE strokes_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    char TEXT NOT NULL REFERENCES characters(char) ON DELETE CASCADE,
    radical INTEGER NOT NULL,            -- 바뀌기 전 strokes 행의 값
    font_outline JSON NOT NULL CHECK (json_valid(font_outline) AND json_type(font_outline) = 'array'),
    stroke_outlines JSON NOT NULL CHECK (json_valid(stroke_outlines) AND json_type(stroke_outlines) = 'array'),
    median_line JSON NOT NULL CHECK (json_valid(median_line) AND json_type(median_line) = 'array'),
    origin TEXT NOT NULL,
    origin_url TEXT,
    state_modified_at DATETIME NOT NULL, -- 그 상태가 만들어진 시각(strokes.last_modified_at)
    state_modified_by TEXT NOT NULL,     -- 그 상태를 만든 주체(strokes.last_modified_by)
    action_desc TEXT NOT NULL,           -- 그 상태를 바꾼 작업. 예: '획 편집', '궁서체 윤곽으로 교체', '실행 취소'
    changed_by TEXT NOT NULL,            -- 바꾼 주체. 'user', 'system:font' 등
    changed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    undoable INTEGER NOT NULL DEFAULT 1 CHECK (undoable IN (0, 1))  -- 1이면 실행 취소의 대상
);

-- 6. 레퍼런스 원본 캐시 (§4.5에서 가져온 원본을 변환 전 그대로 보관)
CREATE TABLE reference_data (
    unicode TEXT NOT NULL,
    source TEXT NOT NULL,                -- 'MMH', 'ACJK', 'NAVER'
    source_version TEXT NOT NULL,        -- 예: 'hanzi-writer-data@2.0', 'animCJK@1c8c8ef45a', 'aniSVG_2026_04'
    source_url TEXT,                     -- 실제로 가져온 주소(AnimCJK는 어느 파일에서 왔는지)
    raw_data TEXT,                       -- 원본 JSON. MMH는 응답 그대로, NAVER는 SVG 그대로, ACJK는 graphics 한 줄에 dictionary의 분해식(acjk)을 붙인 것. 없음 응답이면 NULL
    raw_sha256 TEXT,
    found INTEGER NOT NULL CHECK (found IN (0, 1)),  -- 0이면 해당 출처에 글자 없음(재조회 방지)
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (unicode, source),
    FOREIGN KEY (unicode) REFERENCES characters(unicode) ON DELETE CASCADE
);

-- 7. 레이어 (글자별 화면 레이어의 표시 설정과 내용. 기본 레이어는 설정을 바꾼 것만 행으로 남고, 사용자 레이어는 항상 행이 있다)
--    kind: 'FONT' 궁서체, 'OUTLINE' 획 윤곽 매핑, 'MMH'·'ACJK'·'NAVER' 레퍼런스, 'STROKES' 작업 획, 'MEDIANS'·'NUMBERS' 오버레이, 'CUSTOM' 사용자
--    strokes_json: 획 배열(OUTLINE·레퍼런스·CUSTOM 레이어), paths_json: 윤곽 경로 배열(FONT·CUSTOM). 없으면 NULL
--    modified: 사람이 내용을 바꿨으면 1(레퍼런스 레이어는 원본 대신 이 내용을 쓴다)
CREATE TABLE character_layers (
    char TEXT NOT NULL REFERENCES characters(char) ON DELETE CASCADE,
    layer_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('FONT', 'OUTLINE', 'MMH', 'ACJK', 'NAVER', 'STROKES', 'MEDIANS', 'NUMBERS', 'CUSTOM')),
    name TEXT NOT NULL,
    z_index INTEGER NOT NULL,
    visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
    opacity REAL NOT NULL DEFAULT 1.0 CHECK (opacity >= 0 AND opacity <= 1),
    locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
    label_color TEXT NOT NULL DEFAULT 'none',
    strokes_json JSON CHECK (strokes_json IS NULL OR (json_valid(strokes_json) AND json_type(strokes_json) = 'array')),
    paths_json JSON CHECK (paths_json IS NULL OR (json_valid(paths_json) AND json_type(paths_json) = 'array')),
    modified INTEGER NOT NULL DEFAULT 0 CHECK (modified IN (0, 1)),
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (char, layer_id)
);

-- 8. 변환 이력 (외부 입력을 획 SVG로 바꾼 기록. §4.6). 원본 이미지 바이트는 저장하지 않는다.
--    mode: GUIDED 기존 중심선으로 윤곽을 획별로 나눔 / COMPONENTS 이어진 덩어리 하나를 획 하나로 봄
--    destination: STROKES 기존 획을 교체(strokes_history에 남음) / WORKING 승인 전 작업 데이터
--    threshold·invert: 이진화 경계(0~255)와 반전 여부. result_svg: 결과의 애니메이션 SVG(컴파일이 만드는 것과 같은 형식)
CREATE TABLE conversions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    char TEXT NOT NULL REFERENCES characters(char) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('IMAGE_TO_SVG')),
    source_name TEXT NOT NULL,
    source_mime TEXT NOT NULL,
    source_sha256 TEXT NOT NULL CHECK (length(source_sha256) = 64),
    source_width INTEGER NOT NULL CHECK (source_width > 0),
    source_height INTEGER NOT NULL CHECK (source_height > 0),
    threshold INTEGER NOT NULL CHECK (threshold BETWEEN 0 AND 255),
    invert INTEGER NOT NULL CHECK (invert IN (0, 1)),
    mode TEXT NOT NULL CHECK (mode IN ('GUIDED', 'COMPONENTS')),
    destination TEXT NOT NULL CHECK (destination IN ('STROKES', 'WORKING')),
    stroke_count INTEGER NOT NULL CHECK (stroke_count >= 1),
    result_svg TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_conversions_char ON conversions(char, id DESC);

CREATE INDEX idx_strokes_history_char ON strokes_history(char, id DESC);

-- last_modified_at 자동 갱신 (DEFAULT는 INSERT에만 적용된다). last_modified_by는 쓰는 쪽이 UPDATE에 직접 넣는다.
CREATE TRIGGER trg_characters_updated AFTER UPDATE ON characters
WHEN NEW.last_modified_at = OLD.last_modified_at
BEGIN
    UPDATE characters SET last_modified_at = CURRENT_TIMESTAMP WHERE unicode = NEW.unicode;
END;
```

**수정 사항 요약**

- `strokes`는 글자당 1행이다. `char` 기본키만으로 조회하므로 별도 인덱스가 필요 없고, 획 순서는 `order` 필드가 담는다.
- `characters`에서 `ids_structure`, `ids_source`, `ai_stroke_count`(IDS 분해 결과는 저장하지 않고 합성에만 쓴다), `compiled_json`, `compiled_hash`, `compiled_at`, `raw_ttf_path`, `ref_source`, `ref_url`, `radical_id`, `radical_form`, `issue_reason`을 뺐다. 전체 윤곽·출처·부수는 `strokes`(`font_outline`, `origin`, `origin_url`, `radical`)가 담고, 문제 사유는 `issues`로 분리했다. 부수의 변형 형태(예: 氵)는 저장하지 않고 컴파일 결과에는 강희부수 대표 글자를 쓴다.
- 상태·출처에 `CHECK` 제약을 두어 잘못된 값의 저장을 막는다(`issues.status`, `working_data.source`, `strokes.origin`, `character_layers.kind` 등). 캡 종류(`start_cap`·`end_cap`)는 JSON 안의 값이라 DB가 검사하지 않고 코드(`CAP_TYPES`)가 정한다. SQLite에는 BOOLEAN 타입이 없으므로 `is_radical`은 `INTEGER 0/1`로 명시했다.
- `unicode`는 `U+` + 대문자 16진수(4~6자리)로 고정한다. 확장 B 이후 글자(예: `𮕩` U+2E569)는 UTF-16 서로게이트 쌍이므로, 코드에서 `str.length`나 `str[0]` 대신 `codePointAt`/`[...str]`로 다룬다.
- 획 순서 변경·분할·삭제는 `stroke_outlines`와 `median_line`을 함께 새로 만들어 한 번의 `UPDATE`로 교체하고, 이때 `last_modified_at`/`last_modified_by`를 갱신한다. 글자 단위로 원자적이다.

### 3.1. 작업 상태 (누락 보완)

`characters`에는 상태 열을 두지 않는다. 글자의 상태는 다른 테이블에서 읽는다.

| 상태 | 판단 방법 |
| :--- | :--- |
| 미등록 획 | `strokes` 행도 `working_data` 행도 없다 |
| 레퍼런스 가져옴 | `strokes.origin`이 `'NAVER'`·`'ACJK'`(한국 기준) 또는 `'MMH'`(중국 기준) |
| 작업 전(`OPEN`) | `issues.status = 'OPEN'`. `working_data`가 없거나 궁서체 윤곽만 있다(`source = 'FONT'`). `in_font`로 궁서체 글리프 유무를 구분한다 |
| 승인 대기(`DRAFT`) | `issues.status = 'DRAFT'`이고 `working_data`에 획이 있다 |
| 승인됨 | `issues.status = 'APPROVED'`이고 `strokes`에 있다. `origin`이 `'IDS'`, `'OLLAMA_IDS'`, `'MANUAL'`이다 |

- 사람 검수 완료(과거 `DONE`)는 기록하지 않는다. 컴파일 결과는 DB에 저장하지 않고 `output/compiled/<글자>.json`(그리고 애니메이션 `<글자>.svg`) 파일로만 남기므로, 획을 수정한 뒤에는 다시 컴파일해야 한다.

### 3.2. 마이그레이션

- 스키마 버전은 `PRAGMA user_version`이 담고, 코드의 `MIGRATIONS`(`server/schema/migrate.ts`)가 버전별 변경을 순서대로 적용한다. v1은 버전 기록을 처음 도입한 시점이고, v2는 v1 이전 옛 형식 보정과 `OUTLINE` 레이어 종류 추가, v3은 변환 이력(`conversions`) 추가다. 각 단계는 이미 맞으면 건너뛰어 여러 번 실행해도 안전하다.
- 적용할 마이그레이션이 있고 글자 데이터가 이미 있으면, 적용 전에 `database/chusa1817.before-v<이전 버전>-<시각>.db`로 자동 백업한다(§9.5).
- 앱이 아는 버전보다 높은 DB는 열지 않고 오류를 낸다.
- 새 스키마 변경은 `MIGRATIONS`에 버전을 올려 추가하고, 이미 적용된 항목은 고치지 않는다.

## 4. 핵심 알고리즘 및 엔진 명세

### 4.1. IDS 자소 합성 알고리즘 (Affine Transformation)

- 미등록 한자 발생 시 **코드 안의 수기 IDS(`IDS_BOOK`) → 공개 IDS 데이터(BabelStone `IDS.TXT`) → Ollama(`qwen3.5:9b`)** 순서로 IDS 구조식(예: `⿱水田`)을 구한다. LLM은 IDS를 지어낼 수 있으므로 공개 데이터보다 우선하지 않는다.
  - 구현 메모: `IDS.TXT`(고정 URL `https://www.babelstone.co.uk/CJK/IDS.TXT`)는 처음 필요할 때 한 번 내려받아 `database/IDS.TXT`에 두고 다시 내려받지 않는다(저장소에는 올리지 않는다). 한 글자에 표기가 여럿이면 한국(K) 표기를 먼저 쓰고, `*` 동치 표기와 `{}`·`&;`·`\`가 든 표기는 건너뛴다. 구조식은 트리로 풀어 부품마다 칸(box)을 나눈다(⿰ ⿱ ⿲ ⿳ 및 감싸는 구조 ⿴~⿺, ⿻). 부품 글자가 DB에 없으면 공개 IDS로 한 단계씩 더 쪼개며(최대 3단계), 변형 부수(亻 → 人 등)는 원래 글자의 획을 쓴다. 더 쪼갤 수 없는 부품이 DB에 없으면 실패한다. 결과는 `origin = 'IDS'`, `origin_url`에 `IDS.TXT` 주소를 기록한다. 내려받은 파일의 SHA-256은 아직 기록하지 않는다.
- 기존 DB에 있는 자소(`水`, `田`)의 중심선 Bounding Box를 계산한 뒤, 타겟 궁서체 영역에 맞춰 스케일링 및 평행이동(`fitMedians`, `server/geometry.ts`)을 수행하여 초기 medians를 자동 생성한다. 합성 순서와 부품 칸 계산은 `server/idsCompose.ts`·`server/ids.ts`에 있다.
- **Ollama 요청/응답 규약** (누락 보완):
  - `format`에 JSON Schema를 지정한 구조화 출력을 쓰고, `temperature: 0`, 고정 `seed`(1), `think: false`, `stream: false`로 요청한다. 모델 태그는 코드에 고정했다(`qwen3.5:9b`). 모델을 바꾸면 결과가 달라지지만 `project_meta`에는 기록하지 않는다. 요청 주소는 `http://127.0.0.1:11434/api/generate`, 타임아웃은 60초이고 재시도는 하지 않는다. Ollama가 꺼져 있거나 응답이 JSON이 아니면 경고를 한 번 남기고 IDS 추론 없이 계속한다.
  - 응답 스키마는 `ids` 문자열 하나다. 설계에 있던 `components[].bbox_ratio`·`stroke_count`는 받지 않는다. 모델이 준 비율은 신뢰할 수 없어서 부품 칸은 구조식 기호로 코드가 정한다(§4.5).

    ```json
    { "ids": "⿱水田" }
    ```

  - **검증**: 구조식이 형식에 맞는지(IDS 기술 문자의 인자 개수), 모든 부품의 획을 DB나 공개 IDS 쪼개기(최대 3단계)로 구할 수 있는지 확인한다. 하나라도 실패하면 이 글자는 IDS 합성에 실패한 것으로 보고 `ISSUE`로 보낸다(§4.5 표). 자소 획수 합과 Unihan `kTotalStrokes` 비교는 하지 않는다.
  - 형태 변형을 반영한다. 자소가 좌변·머리 등에 놓이면 형태가 바뀔 수 있으므로(水 → 氵, 心 → 忄, 手 → 扌), 변형 형태는 원래 글자(`LEAF_FORMS`)의 획으로 바꿔 쓴다(별도의 변형 중심선은 두지 않는다).

### 4.2. 자동 외곽선 분할 및 잔여 조각(Residue) 흡수 알고리즘 (래스터 기반)

구현은 `app/shared/strokeCut/`다(`segmentOutlineByMedians`). 원래 설계는 Paper.js의 Boolean 연산(`intersect`·`subtract`·`unite`)이었으나 쓰지 않는다. 윤곽을 격자로 옮겨 픽셀 단위로 계산하고 다시 윤곽을 추적한다. 서버(`server/geometry.ts`)와 화면(`src/lib/strokeOps.ts`)이 같은 모듈을 쓴다.

1. **래스터화**: 글자 전체 윤곽을 곡선 평탄화(허용 오차 1.4)한 뒤 윤곽 방향의 와인딩 수로 격자를 채운다. 안쪽 구멍은 채워지지 않아 보존된다. 섬(Island)을 따로 분해하는 단계는 두지 않는다.
2. **획 배정(브러시 교집합 + 잔여 조각 흡수)**: 잉크 픽셀마다 모든 중심선 선분까지의 거리를 재서 가장 가까운 중심선의 획에 넣는다. 띠(Ribbon)와의 교집합을 먼저 구하고 남은 조각을 나중에 합치는 두 단계가 아니라, 모든 픽셀이 한 번에 어느 획엔가 배정되므로 누락되는 조각이 없다. 배정된 비율은 `coverage`로 돌려준다.
3. **교차부 공유 확장**: 각 중심선을 따라 반경 `default_stroke_width × 0.42`(최소 4픽셀) 원 안의 잉크를 그 획에도 넣는다. 교차한 곳(例: `十`의 가운데)은 두 획이 함께 가져서 가려진 기필·수필이 비지 않는다.
4. **윤곽 추적**: 획별 마스크에서 가장 큰 고리를 윤곽 경로로 추적해 단순화한다. 고리가 없으면 글자 전체 윤곽으로 대신한다.
5. **획 폭 자동 계산**: 획 윤곽의 모든 점에서 중심선까지의 최대 거리 `d_max`를 재서 `strokeWidth = ⌈d_max × 2 + 14⌉`로 한다. 하한은 40, **상한은 `⌊default_stroke_width × 2.5⌋`**이며, 상한을 넘으면 `ISSUE`로 보내지 않고 상한으로 자른다(브러시가 지나치게 두꺼우면 붓이 도착하기 전에 획의 먼 부분이 미리 드러난다).
- 설계에 있던 면적 `canvas_size² × 1e-5` 미만 조각 버리기와, 점수 차 10% 이내·접하지 않는 조각의 `ISSUE` 처리는 구현하지 않았다.
- 이 모듈의 다른 기능: 윤곽에서 중심선·폭 복원(`recoverMedian`: 래스터 → Zhang-Suen 세선화 → 가지치기 → 가장 긴 골격 경로), 칼 분할(`splitStrokeByKnife`, 겹침 포함), 교차 분리 획 추출(`extractStrokeAlongGuide`), 끝 모양 보정(`caps`).

### 4.3. 숨겨진 끝점 복원과 끝 모양 (누락 보완)

기필·수필이 다른 획과 겹쳐 외곽선에서 끝이 보이지 않을 때를 다룬다(예: `田`의 내부 가로획, `十`의 교차부).

1. 교차부는 §4.2의 교차부 공유 확장으로 두 획이 함께 가진다. 중심선 끝점의 접선 방향 연장으로 실제 끝을 추정하는 자동 단계는 구현하지 않았다.
2. 끝 모양은 획마다 `start_cap_type`/`end_cap_type`으로 사람이 고른다(획 목록, `src/lib/capLabels.ts`). 종류는 `CAP_TYPES`다.
   - `NONE`: 모양을 붙이지 않은 기본.
   - `AUTO_ROUND`(둥글게)·`POINTED`(뾰족하게)·`BULGE`(눌러서 부풀림)·`TAPER`(길게 빼기): 끝에서 안쪽으로 획 폭의 0.5·0.9·0.7·1.6배 구간을 끝점으로부터의 거리에 따른 반폭 비율로 다듬는다(`applyCapShape`).
   - `REF_STAMP`(도장)·`MANUAL`(직접 그리기): 모양 프로파일이 아니다. `MANUAL`을 고르면 꼭짓점(베지어) 편집 도구로 넘어가 그 끝의 윤곽을 손으로 고친다. 같은 획 유형에서 캡을 가져와 붙이는 `REF_STAMP` 동작은 구현하지 않았고 표시값으로만 남아 있다.
3. 칼 분할로 새로 생긴 단면에도 같은 방식으로 끝 모양을 입힌다(`applyCapAtFace`).

### 4.4. 어드민 에디터 기능 (누락 보완)

도구는 `EditorTool` 5종이며 도구 막대와 단축키로 고른다.

- **선택·변환**(V): 획 선택, 이동, 크기 변환. Shift+방향키는 선택한 획을 `NUDGE_STEP`(2)만큼 옮긴다.
- **베지어 정점**(A): 앵커와 곡선 제어점 편집.
- **중심선 편집**(M): 점 추가·삭제·이동. 편집하면 윤곽을 §4.2로 다시 나눈다(`POST .../resegment`).
- **윤곽 연결**(P): 시작·중간·끝 3점 이상을 찍어 닫힌 윤곽을 만들고, 선택한 획(또는 윤곽 레이어의 윤곽)을 그 모양으로 바꾼다.
- **칼 분할**(K): 캔버스에서 선을 그어 윤곽을 둘로 자른다. 나뉜 뒤에도 다른 획은 화면에서 사라지지 않는다.
- **필순 변경·삭제·획 속성**: 획 목록의 위·아래 이동 버튼으로 순서를 바꾸고(드래그는 지원하지 않는다), 선택한 획을 삭제하고, 폭·끝 모양·부수 여부를 정한다. 저장은 글자 단위 트랜잭션이다(§3).
- **레이어**: 궁서체·획 윤곽·레퍼런스 3종·작업 획·중심선·번호·사용자 레이어를 눈·투명도·잠금·색 표시로 다룬다. 잠긴 레이어의 내용 저장은 서버도 거부한다. 레퍼런스 레이어는 복제해 편집하거나 원본으로 되돌릴 수 있고, 여러 레이어는 한 요청·한 트랜잭션으로 저장한다.
- **자동 맞춤**(`autoFitToFont`): 획 윤곽을 궁서체 윤곽에 맞추는 변형(이동·배율·회전·기울임)을 래스터 겹침(IoU)이 커지는 방향으로 탐색한다. 변형량에는 한계가 있다(`FIT_LIMIT_*`).
- **실행 취소**: 편집 단위마다 `strokes_history`에 바뀌기 전 행을 남긴다. 실행 취소는 이력을 지우지 않는다. `undoable = 1`인 가장 최근 행으로 `strokes`를 되돌리고, 되돌리기 전 상태를 `undoable = 0` 행으로 남기며, 되돌아간 행은 `undoable = 0`으로 바꿔 더 이상 대상이 되지 않게 한다(연속으로 누르면 한 단계씩 더 전으로 간다). 다시 실행(Redo)은 지원하지 않는다. 보존 정책은 §8.3.

### 4.5. 등록 글자의 레퍼런스 가져오기 (Hanja → IDS)

화면에서 글자를 등록하면, DB에 그 글자의 획 데이터가 있는지 먼저 확인하고 없을 때만 외부 레퍼런스를 가져온다.

**판단 순서**

1. `characters`에 글자가 있고 `strokes` 행이 1개 이상이면 기존 데이터를 연다. `working_data`만 있는 글자는 그 작업 데이터를 연다. 외부 조회는 하지 않는다.
2. 없으면 `characters`에 등록하고, `reference_data`의 캐시를 확인한다. 캐시가 있으면(`found = 0` 포함) 다시 내려받지 않는다.
3. **Hanja**(hanzi-writer-data, Make Me a Hanja 기반)에서 찾는다. 있으면 그 데이터로 채운다.
4. Hanja에 없으면 `strokes`가 아니라 **작업 데이터**에 쓰고 `issues`에 올린다(아래 "작업 데이터와 승인").

**출처별로 가져오는 데이터**

조회 순서는 **네이버 한자사전(한국 획순) → AnimCJK → Hanja(MMH) → 작업 데이터(IDS·Ollama·궁서체)**다. Hanja는 중국 기준이라 한국과 필순·획수가 다른 글자(辶·示·阝·艹가 든 글자 등)가 있어, 한국 기준인 AnimCJK가 있으면 그것을 먼저 쓴다.

- **AnimCJK**(`parsimonhi/animCJK`, 커밋 고정): `graphics{Ja,ZhHant,Ko}.txt`(윤곽 `strokes`·중심선 `medians`, MMH와 같은 형식·좌표계)와 `dictionary{...}.txt`(분해식 `acjk`)를 처음 한 번 `database/`에 내려받아 두고(저장소에는 올리지 않는다) 글자별 원본을 `reference_data`(`source = 'ACJK'`, `source_version = 'animCJK@<커밋 앞 10자>'`)에 둔다. **일본(Ja) → 대만(ZhHant) → 한국(Ko) 순으로 덮어쓰므로 한국이 가장 우선**이고, 어느 파일에서 왔는지는 `origin_url`·`reference_data.source_url`에 남는다. 우리 1817자 중 Ja 1802자, ZhHant 1192자, Ko 520자이며 합쳐서 1810자가 있다(없는 글자: 屛 屢 悅 毁 畓 稅 銳). 내려받기에 실패하면 "없는 글자"로 기록하지 않는다. 라이선스는 Arphic Public License·LGPL(데이터는 Unihan 포함)이다. 부수 색을 따로 칠하려고 획을 쪼갠 `*Special` 폴더는 획수·필순이 달라지므로 쓰지 않고, 유니코드 없는 부품 위주인 `*Zoo`는 우리 글자와 겹치지 않아 쓰지 않는다.
- **부수 획**: `acjk`의 `.` 표시가 붙은 부품의 획 번호를 `is_radical`로 쓴다(예: `近⿺斤4辶.4` → 5~8번째 획). 글자 첫머리에 `.`가 있으면 글자 전체가 부수다. 부품은 그리는 순서로 적혀 있어 구조 기호는 건너뛰고 획수를 누적하며, 합이 가져온 획수와 맞지 않으면 부수를 비운다. 535자 중 534자가 해석되고(由는 부수 표시가 없다) 나머지는 비어 있다.
- **네이버 한자사전**(한국 한자 획순, 사전의 '획순 보기' 팝업이 쓰는 SVG): 글자마다 `https://ssl.pstatic.net/dicimg/cckodict/aniSVG_2026_04/{코드 앞 두 자리}00/{코드}.svg`(U+65E6 → `6500/65E6.svg`)를 필요할 때 하나씩 받아 원본 SVG를 `reference_data`(`source = 'NAVER'`, `source_version = 'aniSVG_2026_04'`)에 둔다. 없는 글자는 404이고, 일괄로 내려받지 않는다. 한국 기준이라 AnimCJK·Hanja와 획수가 다른 글자(迫 9획·菜 12획·飽 14획 등)도 한국식으로 나온다. SVG 읽는 법(`parseNaverSvg`): 윤곽은 `id="U{코드}d{번호}"`, 중심선은 `clip-path="url(#U{코드}c{번호})"`인 경로이고 **번호가 획순**이다(문서 순서는 획순이 아니다). `class="stroke-radical"`이면 부수 획이다. 좌표는 `<g transform="scale(1,-1) translate(tx, ty)">` 안에 있어 글자마다 이동량이 다르므로(`ty`는 -871·-879 등) `x' = x + tx`, `y' = 900 + ty + y`로 저장 좌표계에 옮긴다. 표본 61자에서 윤곽 수와 중심선 수가 모두 같았고 지연(`--d`) 순서와 번호 순서도 일치했다. 저작권 표기는 ©e-hanja(네이버 한자사전)이므로 사내 참고용이며 재배포는 별도 확인이 필요하다.
- **네이버 획순 적용**(`POST /api/characters/{unicode}/apply-naver`, 화면의 '네이버 획순 적용' 버튼): 획순이 틀린 글자를 사람이 골라 그 글자 하나만 네이버 획순으로 바꾼다. `last_modified_by = 'user'`인 글자도 바꾸고(화면에서 확인을 받는다), 바뀌기 전 `strokes` 행은 `strokes_history`('네이버 획순 적용')에 남아 '실행 취소'로 되돌릴 수 있다. 같은 글자의 `working_data`는 지우고 `issues`도 푼다(승인 기록은 남긴다). 네이버에 없는 글자는 아무것도 바꾸지 않고 오류를 낸다. 일괄 적용은 두지 않는다.
- **교체**(`POST /api/apply-acjk`): 이미 있는 글자(`strokes` 또는 승인 전 `working_data`)를 AnimCJK로 바꾼다. 중심선을 길잡이로 궁서체 윤곽을 나누는 과정은 신규 가져오기와 같다. `last_modified_by = 'user'`인 글자는 건너뛰고, 이미 `ACJK`인 글자도 건너뛴다. 교체 전 `strokes` 행은 `strokes_history`('AnimCJK로 교체')에 남고, 같은 글자의 `working_data`는 지운 뒤 `issues`도 푼다(승인 기록은 남긴다). 궁서체 윤곽으로 나뉘면 `last_modified_by = 'system:font'`, 아니면 `'system:acjk'`다. 레퍼런스 수신은 가져온 출처가 같은 글자만 갱신한다.
- **SVG 가져오기**(`POST /api/characters/:unicode/import-svg`, 화면의 "SVG 가져오기" 버튼): AnimCJK 형식 SVG(`makeSvgsFromGraphics.php`가 만드는 모양)를 승인 전 `working_data`로 받는다. 윤곽은 `id="z{코드}d{획}[a-z]"` 경로, 중심선은 `pathLength`가 있는 경로이며 둘 다 문서 순서가 획 순서다. 좌표는 `y = 900 - SVG y`로 바꾸고(`makeGraphicsFromSvgs.php`와 같다), 단 우리가 내보낸 SVG(컴파일·이미지 변환 결과, 그룹 변환 `translate(0 1024) scale(1 -1)`이 있는 파일)는 경로의 숫자가 이미 저장 좌표라 뒤집지 않는다. 경로는 절대 좌표 `M L H V Q C Z`만 받아 H/V는 L로 바꾼다. `<svg id>`의 코드가 선택한 글자와 다르거나 윤곽·중심선 수가 다르면 거부한다. 쪼개진 획(`a`, `b` 접미사)은 원본 스크립트처럼 각각 별개의 획으로 가져오므로 획수가 늘 수 있다. `strokes`에 이미 있는 글자는 받지 않으며, 확인 후 승인해야 `strokes`로 옮겨진다.

| 항목 | Hanja (MMH) |
| :--- | :--- |
| 조회 위치 | `hanzi-writer-data@{고정 버전}/{글자}.json` |
| 중심선 | `medians` (점 배열) |
| 필순 | 배열 순서 (중국 기준) |
| 부수 획 | `radStrokes` (0부터 인덱스) |
| 획 윤곽 | `strokes` (Arphic 해서체 윤곽) |
| 좌표 변환 | §2.1 MMH 규칙 |

- **Hanja는 궁서체 윤곽을 주지 않는다.** MMH의 `strokes`는 Arphic 해서체에서 뽑은 윤곽이므로 최종 `outline_path`로 쓰지 않는다. 궁서체 윤곽은 TTF를 §4.2로 분할해 만든다. TTF에 글자가 없거나 분리가 어긋나 품질 검사를 통과하지 못한 글자만 MMH 윤곽을 그대로 둔다.
- **궁서체 윤곽으로 일괄 교체**(`POST /api/apply-font`): 이미 획이 있는 글자는 기존(Hanja) 중심선을 길잡이로 TTF 윤곽을 획별로 나누고, 중심선과 폭은 새 윤곽에서 다시 계산한다(방향은 길잡이에 맞추고 점은 RDP 허용오차 3으로 줄인다). `last_modified_by = 'user'`인 글자(사람이 고친 것)와 이미 교체된 글자(`'system:font'`)는 건너뛰고, 교체 전 상태는 `strokes_history`에 남겨 실행 취소할 수 있다. 품질 검사: (1) 어느 획도 전체 윤곽 그대로이거나 비어 있으면 안 되고, (2) 획 하나의 면적이 글자 면적의 0.5% 이상이어야 하며, (3) 획 면적의 합이 글자 면적의 0.85~1.7배여야 한다. 하나라도 어기면 그 글자는 바꾸지 않고 목록으로 돌려준다. 교체된 글자는 Hanja 중심선으로 되덮이지 않는다(레퍼런스 수신이 `user`·`system:font` 글자의 중심선을 건드리지 않는다).
- 가져온 중심선은 궁서체 글리프의 외곽 bbox에 맞춰 아핀 변환한 뒤 §4.2 분할에 넣는다. 결과는 출처에 따라 `strokes.origin = 'NAVER'`·`'ACJK'`·`'MMH'`로 저장한다.
- **중심선은 Hanja 값을 그대로 복사한다. 어떤 획의 `medians`가 없거나 점이 2개 미만이면 그 획의 윤곽에서 직접 계산한다**(래스터화 → 골격 추출 → 가장 긴 경로, `recoverMedian`). 윤곽도 없는 글자는 계산할 수 없으므로 IDS 합성으로 넘긴다. 계산한 중심선은 모양은 맞지만(Hanja 값과의 평균 거리 약 1.6) 시작·끝 방향이 뒤집힐 수 있어(표본의 약 4.6%) 필순 검수에서 확인한다.
- **윤곽이 없으면 TTF에서 추출한다.** Hanja에 윤곽이 없거나 IDS 합성으로 만든 글자는(작업 데이터의 `font_outline`; 승인하면 `strokes.font_outline`), 작업 폴더의 `app/fonts/Gungseouche.ttf`(opentype.js로 읽음)에서 글자 윤곽을 꺼내 `strokes.font_outline`에 저장한다. 합성한 중심선 묶음의 bbox를 글자 윤곽 bbox(안쪽으로 20)에 맞춰 늘린 뒤, 윤곽의 각 점을 가장 가까운 중심선에 배정해 획별 윤곽으로 나눈다(§4.2). 결과는 초안이므로 화면에서 칼 분할·중심선 편집으로 고친다. 폰트 파일이 없거나 글자가 없으면 중심선에 폭을 준 띠 모양으로 대신한다.
  - TTF를 처음 읽을 때 SHA-256을 `project_meta`에 기록하고, 이후 해시가 다르면 작업을 멈춘다(§8 보안).
  - 이 폰트는 cmap에 Mac Roman 하위 표가 섞여 있어 opentype.js가 그대로는 읽지 못한다. 메모리 사본에서만 그 표를 무효로 해 유니코드 표(format 4, BMP)를 쓰게 하며 디스크 파일은 바꾸지 않는다. BMP 밖 글자(예: U+2E569)는 이 폰트에 없다.
  - 궁서체 글자는 Hanja 데이터보다 낮게 그려져 있어 y축으로 95만큼 올려 같은 높이에 놓는다.
  - Ollama는 `ids`(구조식) 하나만 답하게 하고(구조화 출력, `think: false`), 부품 칸(box)은 구조식 기호로 코드가 정한다. 모델이 준 비율은 신뢰할 수 없었다. 구조식이 형식에 맞지 않거나 부품이 DB에 없으면 실패로 처리한다. 공개 IDS에도 없는 글자에만 쓰며, 결과 품질이 낮아 반드시 화면에서 고친다.
  - IDS 부품의 중심선은 부품 글자의 모든 획을 한 덩어리로 보고 box에 맞춘다.
- 가져온 필순은 초안이다. 한국 기준과 다를 수 있으므로 §7.3 검수를 거쳐야 한다.

**작업 데이터와 승인**

Hanja에 없는 글자는 `strokes`에 바로 쓰지 않는다. IDS 합성·Ollama·궁서체 추출 결과는 `working_data`에 기록하고 `issues`에 올린 뒤, 사람이 화면에서 확인·수정하고 **승인**해야 `strokes`로 간다.

| 경우 | `working_data` | `issues` |
| :--- | :--- | :--- |
| IDS 합성 성공 (궁서체 유무 무관) | 합성 중심선을 길잡이로 궁서체 윤곽을 획별로 나눈 초안(`source = 'IDS'`·`'OLLAMA_IDS'`·`'MANUAL'`). 분리가 어긋나면 궁서체 전체 윤곽(`font_outline`)과 띠 모양 획. 궁서체에 글자가 없으면 `font_outline = []`에 띠 모양 획 | `DRAFT`, `in_font`는 궁서체 글리프 유무 |
| IDS 합성 실패, 궁서체에 있음 | 궁서체 전체 윤곽만(`source = 'FONT'`, 획 없음) | `OPEN`, `in_font = 1` |
| 둘 다 실패 | 행 없음 | `OPEN`, `in_font = 0` |

- 작업 데이터는 화면의 편집기로 고치며, 편집 내용은 `working_data`에 저장한다(`strokes_history`에는 남기지 않는다). 획이 없던 글자에 획이 생기면 `source`는 `'MANUAL'`이 되고, 획이 1개 이상이면 `issues.status`는 `DRAFT`가 된다. 처음부터 사람이 만드는 수작업의 상세 방식은 별도로 정한다.
- **승인**(`POST /api/characters/{unicode}/approve`): 획 경로·중심선 검증(§7)을 통과하면 작업 데이터를 `strokes`로 옮긴다(`origin = source`, `last_modified_by = 'user'`). 옮긴 `working_data` 행은 삭제하고, `issues`는 지우지 않고 `status = 'APPROVED'`로 바꿔 기록을 남긴다. 승인 전 작업 데이터는 컴파일할 수 없고, 합성에 쓰는 부품(`mediansOfChar`)으로도 쓰이지 않는다.
- 승인된 글자는 `strokes`의 일반 글자처럼 편집·이력 관리(`strokes_history`)를 따른다.

**획수 대조**

- 가져온 획수가 Unihan `kTotalStrokes` 및 궁서체 글리프와 맞지 않으면(정자체/이체자 차이, 예: `靑`/`青`) 자동 매칭하지 않고 `ISSUE`로 보낸다. 이때 `issues.reason`에 출처와 두 획수를 기록한다.

**저장**

- 내려받은 원본은 변환 전에 `reference_data`에 그대로 저장한다. 변환 규칙을 고친 뒤 다시 내려받지 않고 재변환할 수 있게 하기 위해서다.
- 404(글자 없음)도 `found = 0`으로 저장해 같은 글자를 반복 조회하지 않는다. 네트워크 오류는 저장하지 않고 재시도 대상으로 남긴다.

### 4.6. 이미지 가져오기 (래스터 이미지 → 획 SVG)

글자 이미지(PNG·JPEG·WebP)를 획 데이터로 바꾼다. 화면의 '데이터' 메뉴 → '이미지를 획 SVG로 변환…' 으로 쓰고, `POST /api/characters/{unicode}/import-image`가 받는다. AnimCJK의 `makeSvgsFromGraphics.php`·`makeGraphicsFromSvgs.php`는 이미지 변환기가 아니라 획 데이터와 SVG 파일을 오가는 스크립트여서 이미지 추적은 이 프로젝트에서 새로 만들었다. 두 스크립트와 겹치는 부분(경로 정리, y축 뒤집기)은 이미 구현된 `animSvg.ts`가 더 엄밀하므로(소수점 1자리 유지, 획별 폭, 반복 명령 보충) 그대로 두었고, 좌표 규칙도 시스템 것(§2.1)을 따른다.

1. **화면(브라우저)**: 이미지를 디코딩해 긴 변 640픽셀 이하로 줄이고, 투명 부분은 흰 배경으로 합성해 흑백으로 바꾼 뒤 Otsu 방법으로 이진화한다. 어두운 쪽이 절반을 넘으면 반전한다. 이어진 덩어리를 찾아 잡음(전체 잉크의 0.5% 미만)을 버리고, 글자를 사방 64의 여백을 두고 저장 좌표계(0~1024, y축 위쪽) 가운데에 맞춰 덩어리마다 윤곽 경로(구멍 포함)를 만든다(`shared/imageTrace.ts`, `src/lib/imageDecode.ts`). 윤곽 추적·단순화는 §4.2와 같은 `strokeCut` 모듈이다. 덩어리는 읽는 순서(위→아래, 왼→오른)로 정렬한다.
2. **서버**: 윤곽을 검증(허용 경로 문법, `Z`로 닫힘, 좌표 범위, 최대 24개)하고 획으로 나눈다(`server/conversions.ts`).
   - `GUIDED`: 길잡이 중심선(이미 있는 `strokes` 또는 승인 전 `working_data`의 2획 이상)이 있으면 그 중심선으로 윤곽을 획별로 나눈다(`splitByContours`, §4.5의 품질 검사 포함). 부수 표시는 길잡이의 것을 따른다.
   - `COMPONENTS`: 길잡이가 없거나(1획 포함) 요청이 `split: "COMPONENTS"`이면 이어진 덩어리 하나를 획 하나로 보고 윤곽에서 중심선·폭을 복원한다(`recoverMedian`). 중심선을 못 구한 덩어리가 하나라도 있으면 실패한다.
   - 나뉘지 않으면(품질 검사 실패) 저장하지 않고 오류를 낸다.
3. **저장**: `strokes`가 있는 글자는 획을 교체한다(`origin = 'MANUAL'`, `origin_url = 'image:sha256:<해시>'`, 바뀌기 전 행은 `strokes_history`의 '이미지 변환'으로 남아 실행 취소할 수 있다. 화면은 교체 전 확인을 받는다). 없는 글자는 승인 전 `working_data`(`source = 'MANUAL'`)에 두고 `issues`는 `DRAFT`('이미지 변환 초안')로 올린다. 사람이 §4.4 도구로 고친 뒤 승인한다.
4. **기록**: 같은 트랜잭션에서 `conversions`에 원본 이름·형식·SHA-256·크기, 이진화 경계·반전, 방식(`mode`)·저장 위치(`destination`), 획 수, 결과 SVG를 남긴다. 원본 이미지 바이트는 저장·전송하지 않는다. 실패하면 저장도 기록도 남기지 않는다. 이력은 `GET /api/characters/{unicode}/conversions`로 읽는다(최근 것이 먼저).

- **한계**: 한 장의 이미지에는 필순이 없으므로 `COMPONENTS`의 획 순서는 읽는 순서 추정이고, 획이 서로 붙은 글자는 덩어리 하나(1획)로 나온다. 이때는 `GUIDED`(기존 중심선)나 칼 분할로 나눈다. 결과 SVG는 컴파일이 만드는 SVG와 같은 형식이고, 'AnimCJK SVG 가져오기'로 같은 좌표로 다시 읽힌다(§4.5 SVG 가져오기).
- 이미지 크기는 10MB, 형식은 PNG·JPEG·WebP로 제한하며 요청 본문은 §9.2의 8MB 상한을 따른다.

## 5. 뷰어 및 디스플레이 모드 요구사항

> **구현 현황**: 독립된 뷰어 화면은 없다. 어드민 캔버스(`LayerCanvas`)가 편집과 미리보기를 겸한다. 아래 3단계 배경 가이드 토글은 구현하지 않았고, 같은 역할을 레이어 패널의 궁서체·획 윤곽·레퍼런스 레이어의 눈(표시)과 투명도가 한다. 배포용 뷰어는 이 저장소의 범위 밖이다(§11).

- **배경 가이드 모드 (3단계 토글)** — 요구사항:
  - Outline 모드: 분할 전 원본 통짜 패스(`fullOutline`)를 배경에 연하게 채우고 테두리를 선명하게 표시한다(내부 절단선 노출 방지).
  - Silhouette 모드: 회색 실루엣 채움.
  - None 모드: 배경 가이드 없음.
- **부수 색상 하이라이트**: 부수 획(`is_radical`)은 붉은색 계열, 일반 획은 기본색으로 렌더링한다. 화면은 CSS 변수 `--color-radical`을 쓴다(밝은 테마 `#e11d48`, 어두운 테마 `#f43f5e`). 획 목록에는 '부수' 배지도 함께 보여 색만으로 구분하지 않는다.
  - 접근성: 두 색은 흰 배경 대비 WCAG AA(4.5:1) 이상을 유지한다.
- **필순 번호 및 중심선 오버레이**: 각 획의 시작점(`medians[i][0]`)에 번호 배지, 골격선 표시는 `NUMBERS`·`MEDIANS` 레이어의 눈으로 켜고 끈다.
- **애니메이션 재생**: 획 외곽선을 `clipPath`로 두고, 그 안에서 중심선을 `strokeWidths[i]` 두께의 둥근 선으로 그리며 `stroke-dashoffset`을 줄여 드러낸다. 화면의 재생은 `requestAnimationFrame`으로 한 획을 `REVEAL_STROKE_MS`(350ms) 동안 드러낸다.
  - **Start Offset Trick** (정의 보완): `stroke-linecap: round`는 선 길이가 0일 때도 반지름만큼의 원을 먼저 그린다. 이를 막기 위해 `stroke-dasharray`를 `(길이 + strokeWidth)`로 잡고 초기 `stroke-dashoffset`을 `(길이 + strokeWidth)`로 두어, 첫 프레임에는 캡까지 완전히 감춘다.
  - 재생 속도는 중심선 길이에 비례시키되 획당 최소·최대 시간을 둔다(요구사항, 화면은 획당 고정 시간). `prefers-reduced-motion`이 켜져 있으면 애니메이션 없이 획을 순서대로 표시한다(구현됨).

## 6. 최종 배포용 컴파일 JSON 스키마 (`compiled_json`)

**예시 오류 수정**: 기존 예시는 `畓`(논 답)의 부수를 `氵`(85, 물 수)로 적었으나, `畓`의 강희부수는 **`田`(102, 밭 전)**이다. 또한 `畓`의 위쪽 `水`는 삼수변 `氵` 형태로 쓰이지 않는다. 총획은 9획(水 4 + 田 5)이며, 부수 획은 뒤의 5획(인덱스 4~8)이다.

```json
{
  "schemaVersion": 1,
  "character": "畓",
  "unicode": "U+7553",
  "reading": "논 답",
  "strokeCount": 9,
  "coordinateSystem": { "size": 1024, "yAxis": "up" },
  "radical": {
    "id": 102,
    "char": "田",
    "origin": null,
    "name": "밭 전",
    "strokeIndices": [4, 5, 6, 7, 8]
  },
  "fullOutline": "M 482 75 C ... Z",
  "strokes": ["M 482 75 C 515 78 ... Z", "..."],
  "medians": [
    [[510, 88], [512, 260], [420, 415]],
    [[212, 216], [385, 178], [186, 412]]
  ],
  "strokeWidths": [140, 145, 130, 168, 130, 165, 125, 130, 125],
  "source": { "outline": "https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0/畓.json", "medians": "https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0/畓.json" }
}
```

- 위 예시의 `strokes`, `medians`는 지면상 줄였으며, 실제 파일에서는 길이가 모두 `strokeCount`(9)와 같아야 한다.
- 구현(`server/compileOutput.ts`)에서 `fullOutline`은 `strokes.font_outline`의 경로들을 공백으로 이은 문자열이고, `source.outline`과 `source.medians`는 모두 그 글자의 `origin_url`(없으면 `origin`) 하나다. 윤곽과 중심선의 출처를 따로 구분하지 않는다.
- `radical.origin`은 글자 안에서 변형 부수가 쓰일 때 원형을 적는 자리다(예: `江`이면 `char: "氵"`, `origin: "水"`). 현재 구현은 변형 부수를 저장하지 않아 항상 `null`이고, `char`는 강희부수 대표 글자다. `radical`은 부수 번호가 0이면 `null`이다.
- 컴파일은 글자 하나씩(`POST /api/characters/{unicode}/compile`) 하며 일괄 컴파일은 두지 않았다.
- 배열 인덱스는 **0부터** 시작한다. DB `order`(1부터)와 혼동하지 않는다: `strokes[i]`는 `order = i + 1`.
- `schemaVersion`은 뷰어가 하위 호환을 판단하는 기준이다. 필드 의미가 바뀌면 올린다.
- **애니메이션 SVG**: 컴파일하면 같은 이름의 `output/compiled/<글자>.svg`도 만든다. AnimCJK 방식으로, 각 획 윤곽을 `clipPath`로 쓰고 그 위에 중심선을 `stroke-dasharray`(길이 3333으로 정규화한 `pathLength`) 점선으로 그려 `stroke-dashoffset`을 애니메이션한다. 획마다 지연(`--d`)을 1초씩 주고, 폭(`stroke-width`)은 `strokeWidths`를 쓴다. 저장 좌표(y축 위쪽)는 뷰어처럼 `scale(1 -1)`로 뒤집어 그린다.

## 7. 데이터 검증 규칙 (누락 보완)

배포(컴파일) 전에 모든 글자에 대해 자동으로 검사한다. 하나라도 실패하면 컴파일하지 않고 `ISSUE`로 보낸다.

> **구현 현황**: `validate`(`server/compileOutput.ts`)가 컴파일·승인·SVG 가져오기에서 하는 검사는 (1) 획이 1개 이상, (2) 모든 중심선이 2점 이상, (3) 모든 경로가 허용 문법(§9.3)이고 `Z`로 닫힘, 세 가지다. 실패하면 컴파일은 `issues`에 사유를 기록한다. 아래 목록의 나머지(길이 일치, 부수 획 수, 좌표 범위, §7.2 전부, §7.3)는 요구사항이며 아직 자동 검사하지 않는다. 다만 궁서체 윤곽 일괄 교체(§4.5)에는 별도의 품질 검사가 있다.

### 7.1. 구조 검증

- `strokes`, `medians`, `strokeWidths`의 길이 = `strokeCount` = `characters.stroke_count`.
- `radical.strokeIndices`의 모든 값이 `0 ≤ i < strokeCount`이고 중복이 없다. 부수 획 수 = `radicals.stroke_count`.
- 모든 `medians[i]`는 2점 이상이고 좌표가 `0 ~ canvas_size` 범위 안에 있다.
- 모든 SVG 경로는 허용 문법(§9.3)을 통과하고 `Z`로 닫혀 있다.

### 7.2. 기하 검증

- **피복률**: 모든 획의 합집합이 `fullOutline` 면적의 99.5% 이상을 덮는다(누락 조각 방지).
- **이탈률**: 획의 합집합 중 `fullOutline` 밖에 있는 면적이 0.5% 이하이다.
- **애니메이션 완결성**: 각 획에서 중심선을 `strokeWidth`로 그린 영역이 해당 획 외곽선을 99% 이상 덮는다(재생이 끝나도 칠해지지 않는 부분이 남지 않음).
- 각 중심선의 시작점이 해당 획 외곽선 안(또는 §4.3 복원 캡 안)에 있다.

### 7.3. 필순 검수

- 레퍼런스(MMH)에서 가져온 필순과 한국 기준이 다른 글자 목록을 관리하고, 해당 글자는 사람이 검수하기 전에는 완료된 것으로 보지 않는다.
- 획수는 Unihan `kTotalStrokes`와 비교한다. 다르면 정자체/이체자 차이(예: `靑`/`青`)인지 확인한다.

## 8. 성능 요구사항 (누락 보완)

### 8.1. 처리 성능

| 항목 | 목표 |
| :--- | :--- |
| 글자 1자 자동 분할(§4.2) | 평균 1초 이하, 최대 5초 |
| 1,817자 일괄 처리 | 1시간 이하(로컬 Ollama 호출 제외) |
| 에디터에서 중심선 1점 수정 후 재분할 표시 | 200ms 이하 |
| 뷰어 첫 글자 표시 | 1초 이하(일반 모바일 기기) |

- **분할 비용**: Paper.js·Web Worker는 쓰지 않는다(§4.2). 래스터 계산이라 비용은 윤곽 복잡도가 아니라 격자 크기(긴 변 약 560픽셀)와 중심선 선분 수에 비례하고, 서버(`resegment`·`apply-font` 등)와 화면의 편집에서 메인 스레드로 실행한다. 지금까지 처리 시간 목표는 측정해 기록하지 않았다.
- **경로 단순화**: 윤곽은 평탄화(허용 오차 1.4)해 래스터로 옮기고, 추적한 고리는 단순화(`simplifyPolyline`)해 다시 경로로 만든다.
- **Ollama**: `qwen3.5:9b`는 모델 크기가 약 6.6GB이고 그만큼의 메모리가 필요하다. 생각(thinking) 모드를 켜면 응답이 1분 안에 끝나지 않으므로 요청에 `think: false`를 준다. 요청당 타임아웃은 60초(`OLLAMA_TIMEOUT_MS`)다. 재시도와 결과 캐시는 두지 않았고, 호출은 공개 IDS에도 없는 글자를 등록할 때만 일어난다.
- **일괄 처리 중단·재개**: 글자 단위로 커밋하여, 중단 후 재실행하면 `strokes`에도 `working_data`에도 없는 글자만 처리한다.
- **레퍼런스 조회(§4.5)**: 설계는 고정 버전의 hanzi-writer-data를 처음 한 번 로컬에 내려받아 두는 것이었으나, 구현은 글자를 등록할 때 jsDelivr(`hanzi-writer-data@2.0`)에서 그 글자 파일 하나를 받는 방식이다. 요청당 타임아웃은 10초(`FETCH_TIMEOUT_MS`)이고, 캐시(`reference_data`)에 있는 글자는 조회하지 않는다. AnimCJK와 `IDS.TXT`는 처음 한 번 `database/`에 내려받아 둔다. 일괄 작업은 요청마다 처리할 글자 수를 `limit`으로 받고, 없으면 기본값을 쓴다(누락 글자 조회 `MISSING_FETCH_LIMIT` 20자, AnimCJK 교체 `ACJK_BATCH_LIMIT` 200자, 궁서체 교체 `FONT_BATCH_LIMIT` 10자).

### 8.2. DB 성능

- 일괄 쓰기는 글자 단위 트랜잭션으로 묶는다(행마다 커밋하면 수십 배 느려진다).
- WAL 모드에서 장시간 읽기 트랜잭션은 체크포인트를 막아 WAL 파일이 계속 커진다. 일괄 처리 후 `PRAGMA wal_checkpoint(TRUNCATE)`를 실행한다.
- 컴파일은 요청할 때마다 `strokes` 행에서 새로 만든다. 결과는 DB에 두지 않고 파일로만 쓴다.

### 8.3. 용량 관리

- **`strokes_history`**: 감사 기록이므로 삭제하지 않는다. 한 행이 `strokes` 한 행의 전체 값(윤곽·중심선 포함)이라 DB가 그만큼 커진다. 같은 내용을 다시 저장할 때(레퍼런스 재수신 등)는 행을 남기지 않는다. 용량이 문제가 되면 오래된 행을 정리하는 정책을 따로 정한다.
- **배포 JSON**: 좌표 소수점 1자리 반올림, 공백 제거(minify), gzip/brotli 전송을 적용한다. `fullOutline`과 `strokes`는 같은 윤곽을 중복으로 담으므로, 뷰어가 Outline 모드를 쓰지 않는 배포본에서는 `fullOutline`을 생략할 수 있게 한다.
- **배포 단위**: 1,817자를 한 파일로 묶지 말고 글자별 파일로 나누어 필요한 글자만 내려받는다. 뷰어는 내려받은 글자를 캐시한다.

## 9. 보안 요구사항 (누락 보완)

### 9.1. 로컬 LLM (Ollama)

- Ollama는 기본적으로 인증이 없다. `OLLAMA_HOST`를 `127.0.0.1`로만 바인딩하고 `0.0.0.0`으로 열지 않는다. 외부에 노출된 Ollama는 누구나 모델을 실행·삭제할 수 있다.
- LLM 응답은 **신뢰하지 않는 입력**으로 다룬다. JSON Schema 검증(§4.1)을 통과한 값만 쓰고, 응답 문자열을 코드·SQL·HTML에 그대로 넣지 않는다.
- 프롬프트에 들어가는 값은 대상 한자 1자와 고정 지시문뿐이다. 사용자 자유 입력을 프롬프트에 이어 붙이지 않는다(프롬프트 인젝션 차단).

### 9.2. 입력 파일

- **폰트**: TTF 파서는 악성 폰트로 공격받을 수 있다. 신뢰할 수 있는 출처의 폰트만 쓰고, `ttf_sha256`이 `project_meta`와 다르면 작업을 멈추고 경고한다.
- **레퍼런스 데이터**: 버전을 고정하고 내려받은 파일의 SHA-256을 확인하는 것이 요구사항이다. 현재는 AnimCJK만 커밋 해시를 고정했고, MMH는 `hanzi-writer-data@2.0`(2.0.x 범위)이며, `IDS.TXT`는 고정 URL의 최신 파일이다. 내려받은 파일의 SHA-256 확인은 하지 않는다. 글자별 원본의 SHA-256은 `reference_data.raw_sha256`에 기록한다. 화면은 외부 스크립트·스타일을 불러오지 않으므로 SRI는 필요 없다.
- **가져오기**: 에디터에 불러오는 SVG(`import-svg`)와 레이어 저장 요청은 §9.3 경로 검증과 §7.1의 일부(§7 구현 현황)를 통과해야 저장된다. API 요청 본문은 8MB(`API_BODY_LIMIT_BYTES`)까지 받고 넘으면 거부한다.
- **레퍼런스 조회(§4.5)**: 요청 주소는 코드에 고정한 출처(jsDelivr의 hanzi-writer-data, 네이버 한자사전 이미지 서버, GitHub의 AnimCJK 고정 커밋, BabelStone `IDS.TXT`)만 쓰고, 사용자가 주소를 입력할 수 없다. 글자별 응답은 512KB, `IDS.TXT`는 16MB, AnimCJK 파일은 32MB를 넘으면 받지 않는다.

### 9.3. 출력 및 렌더링

- **SVG 경로 주입 방지**: 경로 문자열은 허용 문법만 통과시킨다. 예: `^[MLQCZmlqcz0-9.,\s-]+$`. 경로는 `setAttribute('d', ...)`로만 넣고, `innerHTML`로 SVG 문자열을 조립하지 않는다(경로에 `"/><script>`가 섞이면 XSS가 된다).
- **파일 경로**: 글자로 파일명을 만들 때(`{char}.json`) 대상 한자 리스트에 있는 글자인지 확인하고, 최종 경로가 출력 폴더 안에 있는지 검사한다(`../` 등 경로 탈출 차단).
- **SQL**: 모든 쿼리는 바인딩 파라미터를 쓴다. 문자열 연결로 쿼리를 만들지 않는다.

### 9.4. 로컬 웹 앱

- 데스크톱 셸(Electron·Tauri)은 쓰지 않는다. 화면과 API는 Vite 개발 서버 하나가 제공한다(`npm run dev`). API는 같은 컴퓨터(loopback)에서 온 요청만 받고 그 밖은 403으로 거부한다. 잘못된 요청 주소는 400, 처리 중 예외는 500으로 답하며 서버는 계속 동작한다(`server/apiMiddleware.ts`).
- 화면은 외부 스크립트·스타일을 불러오지 않는다. 폰트(Pretendard 가변 폰트)도 `app/public/fonts/`의 로컬 파일이라, 외부 CSS가 걸려 앱이 뜨지 않는 일이 없다. 외부 네트워크는 서버가 레퍼런스 데이터를 내려받을 때(§4.5)와 Ollama(`127.0.0.1`)에만 쓴다. CSP 메타 태그는 아직 두지 않았다.
- `npm run build`는 DB를 열지 않는다. DB는 개발 서버를 켤 때만 연다.
- 의존성은 `package-lock.json`으로 고정한다. Paper.js는 쓰지 않는다. CI(`.github/workflows/ci.yml`)가 타입 검사·lint·knip·테스트·빌드를 돌린다. `npm audit` 같은 취약점 점검은 정기 작업으로 정해 두지 않았다.

### 9.5. 데이터 보호

- `database/chusa1817.db`는 수작업 결과가 담긴 단일 파일이다. 백업은 `VACUUM INTO`로 만들어(WAL 모드에서 DB 파일만 복사하면 최신 변경이 빠질 수 있다) 무결성을 확인한다(`server/dbBackup.ts`).
  - 수동 백업: `npm run backup`이 `database/chusa1817.backup-<시각>.db`를 만든다. 인자로 다른 폴더를 줄 수 있다.
  - 자동 백업: 마이그레이션을 적용하기 전에 `database/chusa1817.before-v<이전 버전>-<시각>.db`를 만든다(§3.2). 일괄 처리 전 자동 백업은 하지 않는다.
  - 백업 파일은 Git에 올리지 않는다(`.gitignore`).

## 10. 라이선스 요구사항 (누락 보완)

산출물 배포 전에 반드시 확인해야 한다. 법적 검토가 끝나기 전에는 외부 배포를 하지 않는다.

| 자료 | 라이선스 | 영향 |
| :--- | :--- | :--- |
| Make Me a Hanja 획 데이터 | Arphic Public License | 파생 데이터 배포 시 라이선스 사본 동봉, 출처 표기 |
| 궁서체 TTF | 폰트별 상이 | 많은 상용 폰트가 윤곽 추출·파생 데이터 재배포를 금지한다. 폰트 EULA에서 "글꼴 데이터의 변형·추출" 허용 여부를 확인한다 |
| CHISE/BabelStone IDS | 데이터별 상이 | 출처 표기 조건 확인 |
| AnimCJK | Arphic Public License · LGPL(Unihan 포함) | §4.5. 파생 데이터 배포 시 라이선스 표기 |
| 네이버 한자사전 획순 SVG | ©e-hanja | §4.5. 사내 참고용이며 재배포는 별도 확인 |
| Pretendard(화면 폰트) | OFL-1.1 | 저장소에 포함하며 전문은 `app/public/fonts/Pretendard-OFL.txt` |

- `compiled_json.source`에 글자별 데이터 출처를 기록하여, 출처별로 배포 가능 여부를 가려낼 수 있게 한다.

## 11. 미결 사항 (Open Questions)

- 한국 필순의 기준 문헌(교육부 교육용 기초한자 필순 등)을 무엇으로 할지.
- 사용할 궁서체 폰트와 그 라이선스가 윤곽 데이터 재배포를 허용하는지.
- 뷰어 배포 대상(웹, 앱)과 지원 브라우저 범위.
- 사람 검수의 담당자와 검수 기준(합격·불합격 판단 예시).
