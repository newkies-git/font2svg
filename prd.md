# [Master PRD] 한자 획 분리 및 필순 애니메이션 데이터 구축 시스템 (Hanja Stroke Master Studio)

## 1. 프로젝트 개요 (Overview)

- **목적**: 궁서체 TTF 폰트 기반의 한자를 대상으로, 오픈소스 데이터와 로컬 LLM(Ollama)을 결합하여 외곽선(SVG)을 획 단위로 분리하고, Clipping/Masking 방식의 필순 애니메이션용 정적 데이터(`compiled_json`)를 생성하는 데스크톱 어드민(Pre-processor) 및 뷰어 시스템 구축.
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
| 실행 환경 | 오프라인 데스크톱(로컬 Ollama 포함) | 클라우드 LLM 호출, 다중 사용자 동시 편집 |

### 1.2. 용어 (Glossary)

- **섬(Island)**: 외곽선 중 서로 닿지 않는 하나의 채움 영역. 안쪽 구멍을 포함할 수 있다.
- **중심선(Median)**: 획의 붓 진행 경로를 나타내는 점 배열. 첫 점이 기필, 마지막 점이 수필이다.
- **잔여 조각(Residue)**: 브러시 교집합 분할 후 어떤 획에도 속하지 않은 외곽선 조각.
- **기필/수필**: 획의 시작점/끝점.

## 2. 시스템 아키텍처 및 데이터 파이프라인

1. **Input Layer**: 궁서체 `.ttf` 파일 + 대상 한자 리스트 + 레퍼런스 DB(Make Me a Hanja) + IDS 데이터(CHISE/BabelStone IDS) + 로컬 Ollama(`qwen3.5:9b`).
2. **AI & Import Engine**: 화면에서 글자 등록 → DB에 데이터가 없으면 레퍼런스 가져오기(Hanja, §4.5) → 없으면 IDS 조회(공개 IDS 데이터 우선, 없으면 Ollama 추론) → 아핀 변환(Affine Transform)을 통한 초기 중심선 합성.
3. **Pre-processing Engine (Geometry)**: 좌표 정규화(§2.1) → 구멍(Hole) 보존형 섬(Island) 분해 → 브러시 교집합 분할(Boolean Intersect) → 잔여 조각(Residue) 흡수 및 `strokeWidth` 자동 확장 → 숨겨진 끝점 복원(§4.3).
4. **Admin Editor**: 수동 보정, 나이프 툴 편집, 부수 태깅, 실시간 프리뷰(§4.4).
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
PRAGMA user_version = 1;  -- 스키마 버전. 마이그레이션 시 증가

-- 1. 프로젝트 메타데이터
CREATE TABLE project_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    project_name TEXT NOT NULL,
    ttf_filename TEXT NOT NULL,
    ttf_sha256 TEXT NOT NULL CHECK (length(ttf_sha256) = 64),
    ttf_units_per_em INTEGER NOT NULL,
    canvas_size INTEGER NOT NULL DEFAULT 1024 CHECK (canvas_size > 0),
    default_stroke_width INTEGER NOT NULL DEFAULT 135 CHECK (default_stroke_width > 0),
    stroke_order_standard TEXT NOT NULL DEFAULT 'KR',  -- 최종 필순 기준
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,     -- UTC
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. 부수(Radicals) 마스터 사전 (강희 214부수 및 변형)
CREATE TABLE radicals (
    id INTEGER PRIMARY KEY CHECK (id BETWEEN 1 AND 214),  -- 강희부수 번호
    radical_char TEXT NOT NULL UNIQUE,
    variant_chars TEXT,                  -- JSON 배열. 예: '["氵","氺"]'
    name_kr TEXT NOT NULL,
    stroke_count INTEGER NOT NULL CHECK (stroke_count > 0)
);

-- 3. 한자 마스터 테이블
CREATE TABLE characters (
    unicode TEXT PRIMARY KEY CHECK (unicode GLOB 'U+[0-9A-F][0-9A-F][0-9A-F][0-9A-F]*'),  -- 'U+7553', 'U+2E569'
    char TEXT NOT NULL UNIQUE,
    grade TEXT,                          -- 구분: '중등', '고등', '3급' (한문 교육용 기초 한자 1800자 + 3급 17자)

    -- 음훈 정보
    reading TEXT,                        -- 대표 음. 예: '락'
    meaning TEXT,                        -- 대표 훈. 예: '즐길'
    variant_reading JSON NOT NULL DEFAULT '[]'  -- 다른 음 배열. 예: '["악", "요"]'
        CHECK (json_valid(variant_reading) AND json_type(variant_reading) = 'array'),
    variant_meaning JSON NOT NULL DEFAULT '[]'  -- 다른 훈 배열. 예: '["노래", "좋아할"]'
        CHECK (json_valid(variant_meaning) AND json_type(variant_meaning) = 'array'),

    stroke_count INTEGER NOT NULL DEFAULT 0 CHECK (stroke_count >= 0),
    last_modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,   -- UTC
    last_modified_by TEXT NOT NULL       -- 'user', 'system:hanja', 'system:ids', 'system:font', 'system:migration'
);

-- 3-1. 문제 사유 테이블: 문제가 있는 글자(`ISSUE`)의 원인. 글자당 최대 1행이며, 문제가 풀리면 지운다.
CREATE TABLE issues (
    char TEXT PRIMARY KEY REFERENCES characters(char) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. 획(Stroke) 테이블: 글자당 1행. font_outline, stroke_outlines, median_line은 JSON이다.
--    SQLite에는 별도 JSON 타입이 없으므로 JSON 선언 타입 + json_valid CHECK로 검증한다.
--    radical         : 강희부수 번호. 0이면 미지정.
--    font_outline    : 글자 전체 윤곽. SVG Path 문자열의 배열 ('["M ... Z", ...]'). 편집해도 바뀌지 않는다.
--    stroke_outlines : 획별 윤곽. [{ "order": 1, "path": "M ... Z", "radical": 1 }, ...]
--                      order는 1부터 시작하는 필순(§6 JSON 배열 인덱스는 0부터), radical은 부수 획이면 1, 아니면 0.
--    median_line     : 획별 중심선. [{ "order": 1, "points": [[x,y], ...], "width": 135,
--                      "start_cap": "NONE|AUTO_ROUND|REF_STAMP", "end_cap": "..." }, ...]
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
    origin TEXT NOT NULL CHECK (origin IN ('MMH', 'IDS', 'OLLAMA_IDS', 'MANUAL', 'NONE')),  -- 획 데이터의 출처. IDS=공개 IDS 합성, OLLAMA_IDS=Ollama 합성
    origin_url TEXT                      -- 실제로 가져온 주소. 없으면 NULL
);

-- 5. 작업 히스토리 (Undo / 버전 백업)
CREATE TABLE edit_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    unicode TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    action_desc TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (unicode) REFERENCES characters(unicode) ON DELETE CASCADE
);

-- 6. 레퍼런스 원본 캐시 (§4.5에서 가져온 원본을 변환 전 그대로 보관)
CREATE TABLE reference_data (
    unicode TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('MMH')),
    source_version TEXT NOT NULL,        -- 예: 'hanzi-writer-data@2.0.1'
    raw_data TEXT,                       -- 원본 JSON(MMH). 없음 응답이면 NULL
    raw_sha256 TEXT,
    found INTEGER NOT NULL CHECK (found IN (0, 1)),  -- 0이면 해당 출처에 글자 없음(재조회 방지)
    fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (unicode, source),
    FOREIGN KEY (unicode) REFERENCES characters(unicode) ON DELETE CASCADE
);

CREATE INDEX idx_edit_history_unicode_time ON edit_history(unicode, created_at DESC);

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
- 상태·출처·캡 종류에 `CHECK` 제약을 두어 잘못된 값의 저장을 막는다. SQLite에는 BOOLEAN 타입이 없으므로 `is_radical`은 `INTEGER 0/1`로 명시했다.
- `unicode`는 `U+` + 대문자 16진수(4~6자리)로 고정한다. 확장 B 이후 글자(예: `𮕩` U+2E569)는 UTF-16 서로게이트 쌍이므로, 코드에서 `str.length`나 `str[0]` 대신 `codePointAt`/`[...str]`로 다룬다.
- 획 순서 변경·분할·삭제는 `stroke_outlines`와 `median_line`을 함께 새로 만들어 한 번의 `UPDATE`로 교체하고, 이때 `last_modified_at`/`last_modified_by`를 갱신한다. 글자 단위로 원자적이다.

### 3.1. 작업 상태 (누락 보완)

`characters`에는 상태 열을 두지 않는다. 글자의 상태는 다른 테이블에서 읽는다.

| 상태 | 판단 방법 |
| :--- | :--- |
| 미등록 획 | `strokes` 행이 없다 |
| 레퍼런스 가져옴 | `strokes.origin = 'MMH'` |
| 합성 초안 | `strokes.origin`이 `'IDS'`, `'OLLAMA_IDS'`, `'MANUAL'` |
| 문제(`ISSUE`) | `issues` 행이 있다 |

- 사람 검수 완료(과거 `DONE`)는 기록하지 않는다. 컴파일 결과는 DB에 저장하지 않고 `output/compiled/<글자>.json` 파일로만 남기므로, 획을 수정한 뒤에는 다시 컴파일해야 한다.

## 4. 핵심 알고리즘 및 엔진 명세

### 4.1. IDS 자소 합성 알고리즘 (Affine Transformation)

- 미등록 한자 발생 시 **코드 안의 수기 IDS(`IDS_BOOK`) → 공개 IDS 데이터(BabelStone `IDS.TXT`) → Ollama(`qwen3.5:9b`)** 순서로 IDS 구조식(예: `⿱水田`)을 구한다. LLM은 IDS를 지어낼 수 있으므로 공개 데이터보다 우선하지 않는다.
  - 구현 메모: `IDS.TXT`(고정 URL `https://www.babelstone.co.uk/CJK/IDS.TXT`)는 처음 필요할 때 한 번 내려받아 `database/IDS.TXT`에 두고 다시 내려받지 않는다(저장소에는 올리지 않는다). 한 글자에 표기가 여럿이면 한국(K) 표기를 먼저 쓰고, `*` 동치 표기와 `{}`·`&;`·`\`가 든 표기는 건너뛴다. 구조식은 트리로 풀어 부품마다 칸(box)을 나눈다(⿰ ⿱ ⿲ ⿳ 및 감싸는 구조 ⿴~⿺, ⿻). 부품 글자가 DB에 없으면 공개 IDS로 한 단계씩 더 쪼개며(최대 3단계), 변형 부수(亻 → 人 등)는 원래 글자의 획을 쓴다. 더 쪼갤 수 없는 부품이 DB에 없으면 실패한다. 결과는 `origin = 'IDS'`, `origin_url`에 `IDS.TXT` 주소를 기록한다. 내려받은 파일의 SHA-256은 아직 기록하지 않는다.
- 기존 DB에 있는 자소(`水`, `田`)의 중심선 Bounding Box를 계산한 뒤, 타겟 궁서체 영역에 맞춰 스케일링 및 평행이동(`transformMediansToTarget`)을 수행하여 초기 medians를 자동 생성한다.
- **Ollama 요청/응답 규약** (누락 보완):
  - `format`에 JSON Schema를 지정한 구조화 출력(structured outputs)을 사용하고, `temperature: 0`과 고정 `seed`로 재현성을 확보한다. 모델은 태그까지 고정한다(예: `qwen3.5:9b`). 모델 변경 시 결과가 달라지므로 `project_meta`에 기록한다.
  - 응답 스키마:

    ```json
    {
      "ids": "⿱水田",
      "components": [
        { "char": "水", "bbox_ratio": [0.0, 0.0, 1.0, 0.45] },
        { "char": "田", "bbox_ratio": [0.1, 0.45, 0.9, 1.0] }
      ],
      "stroke_count": 9
    }
    ```

  - **검증**: (1) IDS 기술 문자(`⿰`~`⿻`)의 인자 개수가 맞는지, (2) 모든 자소가 DB에 존재하는지, (3) 자소 획수 합 = `stroke_count` = Unihan `kTotalStrokes`인지, (4) `bbox_ratio`가 0~1 범위인지 확인한다. 하나라도 실패하면 `ISSUE`로 보낸다.
  - 형태 변형을 반영한다. 자소가 좌변·머리 등에 놓이면 형태가 바뀔 수 있으므로(水 → 氵, 心 → 忄, 手 → 扌), 변형 형태의 중심선을 따로 쓴다.

### 4.2. 자동 외곽선 분할 및 잔여 조각(Residue) 흡수 알고리즘 (Paper.js)

1. **구멍(Hole) 보존형 섬 분해**: TTF 통짜 Path를 면적 및 포함 관계(`contains`)를 분석하여 안쪽 구멍이 뚫린 복합 패스(CompoundPath) 섬들로 분리한다.
   - 포함 관계는 bbox가 아니라 **윤곽 내부의 표본점**으로 판정한다(bbox 포함은 `口` 안의 획처럼 서로 떨어진 섬을 구멍으로 오판한다).
   - TrueType은 바깥 윤곽이 시계 방향, 구멍이 반시계 방향인 **nonzero** 채움 규칙을 따른다. 방향이 뒤집힌 폰트에 대비해 방향을 정규화한 뒤 분해한다.
2. **브러시 교집합 분할 (Boolean Intersect)**: 중심선 좌표를 따라 생성된 가상 브러시 띠(Ribbon Envelope)와 외곽선 섬의 교집합을 구해 1차 분할한다.
3. **잔여 조각 흡수 (Residue Absorption)**:
   - 원본 섬에서 1차 분할된 획들을 차집합(`subtract`)하여 잘려 나간 삐침/파임/세리프 끝 조각(Residue)들을 추출한다.
   - 각 조각의 접촉면 및 중심선 거리를 복합 평가하여 가장 인접한 획에 `unite`로 병합한다.
   - **예외 처리** (누락 보완): 면적이 `canvas_size² × 1e-5` 미만인 조각은 부동소수점 잡음으로 보고 버린다. 두 획의 점수 차가 10% 이내이거나 어떤 획과도 접하지 않는 조각은 자동 병합하지 않고 `ISSUE`로 보낸다.
4. **브러시 두께 자동 확장**: 흡수된 조각의 최외곽 거리(`d_max`, 중심선으로부터의 거리, 캔버스 단위)를 측정하여 해당 획의 `strokeWidth`를 `⌈d_max × 2 + 14⌉`로 자동 상향하여 칠해지지 않는 영역(Unpainted Pixel)을 원천 차단한다.
   - **상한** (누락 보완): `strokeWidth`는 `default_stroke_width × 2.5`를 넘지 않는다. 브러시가 지나치게 두꺼우면 붓이 도착하기 전에 획의 먼 부분이 미리 드러난다. 상한을 넘으면 `ISSUE`로 보내 중심선 보정을 요구한다.

### 4.3. 숨겨진 끝점 복원 (누락 보완)

개요에서 해결 과제로 제시했으나 명세가 없던 항목이다. 기필·수필이 다른 획과 겹쳐 외곽선에서 끝이 보이지 않을 때 적용한다(예: `田`의 내부 가로획, `十`의 교차부).

1. 중심선 끝점이 다른 획의 영역 안에 있으면, 끝점의 접선 방향으로 중심선을 연장해 겹침 영역을 벗어나지 않는 범위에서 실제 끝을 추정한다.
2. 끝 모양은 `start_cap_type`/`end_cap_type`으로 결정한다.
   - `AUTO_ROUND`: 끝점의 국소 획 폭을 반지름으로 하는 둥근 캡을 만든다.
   - `REF_STAMP`: 같은 획 유형(가로, 세로, 삐침 등)의 다른 글자에서 드러나 있는 캡 모양을 가져와 크기와 방향을 맞춰 붙인다.
3. 복원된 캡은 해당 획의 `outline_path`에 합치되, 원본 외곽선(`fullOutline`) 밖으로 나가는 부분은 잘라낸다.

### 4.4. 어드민 에디터 기능 (누락 보완)

- **나이프 툴**: 캔버스에서 선을 그어 외곽선 조각을 두 개로 자르고, 각 조각을 원하는 획에 배정한다.
- **중심선 편집**: 점 추가·삭제·이동. 편집 즉시 §4.2 분할을 해당 섬에 대해서만 다시 실행한다.
- **필순 변경**: 획 목록 드래그로 순서를 바꾼다. 저장은 단일 트랜잭션으로 처리한다(§3).
- **Undo/Redo**: 편집 단위마다 `edit_history`에 스냅샷을 남긴다. 보존 정책은 §8.3.

### 4.5. 등록 글자의 레퍼런스 가져오기 (Hanja → IDS)

화면에서 글자를 등록하면, DB에 그 글자의 획 데이터가 있는지 먼저 확인하고 없을 때만 외부 레퍼런스를 가져온다.

**판단 순서**

1. `characters`에 글자가 있고 `strokes` 행이 1개 이상이면 기존 데이터를 연다. 외부 조회는 하지 않는다.
2. 없으면 `characters`에 등록하고, `reference_data`의 캐시를 확인한다. 캐시가 있으면(`found = 0` 포함) 다시 내려받지 않는다.
3. **Hanja**(hanzi-writer-data, Make Me a Hanja 기반)에서 찾는다. 있으면 그 데이터로 채운다.
4. Hanja에 없으면 §4.1 IDS 자소 합성으로 넘긴다.

**출처별로 가져오는 데이터**

| 항목 | Hanja (MMH) |
| :--- | :--- |
| 조회 위치 | `hanzi-writer-data@{고정 버전}/{글자}.json` |
| 중심선 | `medians` (점 배열) |
| 필순 | 배열 순서 (중국 기준) |
| 부수 획 | `radStrokes` (0부터 인덱스) |
| 획 윤곽 | `strokes` (Arphic 해서체 윤곽) |
| 좌표 변환 | §2.1 MMH 규칙 |

- **Hanja는 궁서체 윤곽을 주지 않는다.** MMH의 `strokes`는 Arphic 해서체에서 뽑은 윤곽이므로 최종 `outline_path`로 쓰지 않는다. 궁서체 윤곽은 TTF를 §4.2로 분할해 만든다. TTF에 글자가 없거나 분리가 어긋나 품질 검사를 통과하지 못한 글자만 MMH 윤곽을 그대로 둔다.
- **궁서체 윤곽으로 일괄 교체**(`POST /api/apply-font`): 이미 획이 있는 글자는 기존(Hanja) 중심선을 길잡이로 TTF 윤곽을 획별로 나누고, 중심선과 폭은 새 윤곽에서 다시 계산한다(방향은 길잡이에 맞추고 점은 RDP 허용오차 3으로 줄인다). `last_modified_by = 'user'`인 글자(사람이 고친 것)와 이미 교체된 글자(`'system:font'`)는 건너뛰고, 교체 전 상태는 `edit_history`에 남겨 실행 취소할 수 있다. 품질 검사: (1) 어느 획도 전체 윤곽 그대로이거나 비어 있으면 안 되고, (2) 획 하나의 면적이 글자 면적의 0.5% 이상이어야 하며, (3) 획 면적의 합이 글자 면적의 0.85~1.7배여야 한다. 하나라도 어기면 그 글자는 바꾸지 않고 목록으로 돌려준다. 교체된 글자는 Hanja 중심선으로 되덮이지 않는다(레퍼런스 수신이 `user`·`system:font` 글자의 중심선을 건드리지 않는다).
- 가져온 중심선은 궁서체 글리프의 외곽 bbox에 맞춰 아핀 변환한 뒤 §4.2 분할에 넣는다. 결과는 `strokes.origin = 'MMH'`로 저장한다.
- **중심선은 Hanja 값을 그대로 복사한다. 어떤 획의 `medians`가 없거나 점이 2개 미만이면 그 획의 윤곽에서 직접 계산한다**(래스터화 → 골격 추출 → 가장 긴 경로, `recoverMedian`). 윤곽도 없는 글자는 계산할 수 없으므로 IDS 합성으로 넘긴다. 계산한 중심선은 모양은 맞지만(Hanja 값과의 평균 거리 약 1.6) 시작·끝 방향이 뒤집힐 수 있어(표본의 약 4.6%) 필순 검수에서 확인한다.
- **윤곽이 없으면 TTF에서 추출한다.** Hanja에 윤곽이 없거나 IDS 합성으로 만든 글자는, 작업 폴더의 `app/fonts/Gungseouche.ttf`(opentype.js로 읽음)에서 글자 윤곽을 꺼내 `strokes.font_outline`에 저장한다. 합성한 중심선 묶음의 bbox를 글자 윤곽 bbox(안쪽으로 20)에 맞춰 늘린 뒤, 윤곽의 각 점을 가장 가까운 중심선에 배정해 획별 윤곽으로 나눈다(§4.2). 결과는 초안이므로 화면에서 칼 분할·중심선 편집으로 고친다. 폰트 파일이 없거나 글자가 없으면 중심선에 폭을 준 띠 모양으로 대신한다.
  - TTF를 처음 읽을 때 SHA-256을 `project_meta`에 기록하고, 이후 해시가 다르면 작업을 멈춘다(§8 보안).
  - 이 폰트는 cmap에 Mac Roman 하위 표가 섞여 있어 opentype.js가 그대로는 읽지 못한다. 메모리 사본에서만 그 표를 무효로 해 유니코드 표(format 4, BMP)를 쓰게 하며 디스크 파일은 바꾸지 않는다. BMP 밖 글자(예: U+2E569)는 이 폰트에 없다.
  - 궁서체 글자는 Hanja 데이터보다 낮게 그려져 있어 y축으로 95만큼 올려 같은 높이에 놓는다.
  - Ollama는 `ids`(구조식) 하나만 답하게 하고(구조화 출력, `think: false`), 부품 칸(box)은 구조식 기호로 코드가 정한다. 모델이 준 비율은 신뢰할 수 없었다. 구조식이 형식에 맞지 않거나 부품이 DB에 없으면 실패로 처리한다. 공개 IDS에도 없는 글자에만 쓰며, 결과 품질이 낮아 반드시 화면에서 고친다.
  - IDS 부품의 중심선은 부품 글자의 모든 획을 한 덩어리로 보고 box에 맞춘다.
- 가져온 필순은 초안이다. 한국 기준과 다를 수 있으므로 §7.3 검수를 거쳐야 한다.

**획수 대조**

- 가져온 획수가 Unihan `kTotalStrokes` 및 궁서체 글리프와 맞지 않으면(정자체/이체자 차이, 예: `靑`/`青`) 자동 매칭하지 않고 `ISSUE`로 보낸다. 이때 `issues.reason`에 출처와 두 획수를 기록한다.

**저장**

- 내려받은 원본은 변환 전에 `reference_data`에 그대로 저장한다. 변환 규칙을 고친 뒤 다시 내려받지 않고 재변환할 수 있게 하기 위해서다.
- 404(글자 없음)도 `found = 0`으로 저장해 같은 글자를 반복 조회하지 않는다. 네트워크 오류는 저장하지 않고 재시도 대상으로 남긴다.

## 5. 뷰어 및 디스플레이 모드 요구사항

- **배경 가이드 모드 (3단계 토글)**:
  - Outline 모드: 분할 전 원본 통짜 패스(`fullOutline`)를 배경에 연하게 채우고 테두리를 선명하게 표시한다(내부 절단선 노출 방지).
  - Silhouette 모드: 회색 실루엣 채움.
  - None 모드: 배경 가이드 없음.
- **부수 색상 하이라이트**: `radical.strokeIndices`에 포함된 획은 붉은색 계열(`#e11d48`), 일반 획은 기본색(`#0f172a`)으로 자동 렌더링한다.
  - 접근성: 색만으로 부수를 구분하지 않도록, 부수 획에는 범례와 함께 테두리 또는 패턴을 병행할 수 있게 한다. 두 색은 흰 배경 대비 WCAG AA(4.5:1) 이상을 유지한다.
- **필순 번호 및 중심선 오버레이**: 각 획의 시작점(`medians[i][0]`)에 번호 배지 표시 토글 및 골격선 표시 토글.
- **애니메이션 재생**: 획 외곽선을 `clipPath`로 두고, 그 안에서 중심선을 `strokeWidths[i]` 두께의 둥근 선으로 그리며 `stroke-dashoffset`을 줄여 드러낸다.
  - **Start Offset Trick** (정의 보완): `stroke-linecap: round`는 선 길이가 0일 때도 반지름만큼의 원을 먼저 그린다. 이를 막기 위해 `stroke-dasharray`를 `(길이 + strokeWidth)`로 잡고 초기 `stroke-dashoffset`을 `(길이 + strokeWidth)`로 두어, 첫 프레임에는 캡까지 완전히 감춘다.
  - 재생 속도는 중심선 길이에 비례시키되 획당 최소·최대 시간을 둔다. `prefers-reduced-motion`이 켜져 있으면 애니메이션 없이 획을 순서대로 표시한다.

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
  "source": { "outline": "궁서체 TTF", "medians": "MMH" }
}
```

- 위 예시의 `strokes`, `medians`는 지면상 줄였으며, 실제 파일에서는 길이가 모두 `strokeCount`(9)와 같아야 한다.
- `radical.origin`은 글자 안에서 변형 부수가 쓰일 때 원형을 적는다(예: `江`이면 `char: "氵"`, `origin: "水"`). 변형이 아니면 `null`.
- 배열 인덱스는 **0부터** 시작한다. DB `order`(1부터)와 혼동하지 않는다: `strokes[i]`는 `order = i + 1`.
- `schemaVersion`은 뷰어가 하위 호환을 판단하는 기준이다. 필드 의미가 바뀌면 올린다.

## 7. 데이터 검증 규칙 (누락 보완)

배포(컴파일) 전에 모든 글자에 대해 자동으로 검사한다. 하나라도 실패하면 컴파일하지 않고 `ISSUE`로 보낸다.

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

- **Boolean 연산 비용**: Paper.js의 `intersect`/`subtract`/`unite`는 세그먼트 수에 따라 비용이 급격히 커지고 UI 스레드를 막는다. 분할은 **Web Worker**에서 실행하고, 편집 시 전체 글자가 아니라 변경된 섬만 다시 계산한다.
- **경로 단순화**: 브러시 띠는 곡선 그대로 Boolean 연산에 넣지 말고, 허용 오차(예: 0.5 단위)로 평탄화한 뒤 연산하고 결과를 다시 곡선으로 맞춘다.
- **Ollama**: `qwen3.5:9b`는 모델 크기가 약 6.6GB이고 그만큼의 메모리가 필요하다. 생각(thinking) 모드를 켜면 응답이 1분 안에 끝나지 않으므로 요청에 `think: false`를 준다. 동시 요청은 1개로 제한하고, 요청당 타임아웃(예: 60초)과 재시도 1회를 둔다. 같은 글자의 결과는 DB에 캐시하여 다시 호출하지 않는다.
- **일괄 처리 중단·재개**: 글자 단위로 커밋하여, 중단 후 재실행하면 획이 없거나 `issues`에 있는 글자만 처리한다.
- **레퍼런스 조회(§4.5)**: 글자를 등록할 때마다 CDN에 요청하지 않도록, 고정 버전의 hanzi-writer-data를 처음 한 번 로컬에 내려받아 두고 로컬에서 찾는 방식을 기본으로 한다. 원격 조회를 쓸 경우 동시 요청 4개 이하, 요청 간 지연, 요청당 타임아웃 10초를 둔다. 캐시(`reference_data`)에 있는 글자는 조회하지 않는다.

### 8.2. DB 성능

- 일괄 쓰기는 글자 단위 트랜잭션으로 묶는다(행마다 커밋하면 수십 배 느려진다).
- WAL 모드에서 장시간 읽기 트랜잭션은 체크포인트를 막아 WAL 파일이 계속 커진다. 일괄 처리 후 `PRAGMA wal_checkpoint(TRUNCATE)`를 실행한다.
- 컴파일은 요청할 때마다 `strokes` 행에서 새로 만든다. 결과는 DB에 두지 않고 파일로만 쓴다.

### 8.3. 용량 관리

- **`edit_history`**: 글자당 최근 50개 스냅샷만 유지하고 나머지는 삭제한다. 스냅샷은 전체 글자가 아니라 변경된 획만 담는다. 정리 후 주기적으로 `VACUUM`을 실행한다.
- **배포 JSON**: 좌표 소수점 1자리 반올림, 공백 제거(minify), gzip/brotli 전송을 적용한다. `fullOutline`과 `strokes`는 같은 윤곽을 중복으로 담으므로, 뷰어가 Outline 모드를 쓰지 않는 배포본에서는 `fullOutline`을 생략할 수 있게 한다.
- **배포 단위**: 1,817자를 한 파일로 묶지 말고 글자별 파일로 나누어 필요한 글자만 내려받는다. 뷰어는 내려받은 글자를 캐시한다.

## 9. 보안 요구사항 (누락 보완)

### 9.1. 로컬 LLM (Ollama)

- Ollama는 기본적으로 인증이 없다. `OLLAMA_HOST`를 `127.0.0.1`로만 바인딩하고 `0.0.0.0`으로 열지 않는다. 외부에 노출된 Ollama는 누구나 모델을 실행·삭제할 수 있다.
- LLM 응답은 **신뢰하지 않는 입력**으로 다룬다. JSON Schema 검증(§4.1)을 통과한 값만 쓰고, 응답 문자열을 코드·SQL·HTML에 그대로 넣지 않는다.
- 프롬프트에 들어가는 값은 대상 한자 1자와 고정 지시문뿐이다. 사용자 자유 입력을 프롬프트에 이어 붙이지 않는다(프롬프트 인젝션 차단).

### 9.2. 입력 파일

- **폰트**: TTF 파서는 악성 폰트로 공격받을 수 있다. 신뢰할 수 있는 출처의 폰트만 쓰고, `ttf_sha256`이 `project_meta`와 다르면 작업을 멈추고 경고한다.
- **레퍼런스 데이터**: MMH, IDS 데이터는 버전(커밋 해시 또는 릴리스)을 고정하고 내려받은 파일의 SHA-256을 확인한다. CDN에서 직접 불러올 때는 버전을 고정한 URL과 SRI(`integrity`)를 쓴다.
- **JSON 가져오기**: 에디터에 불러오는 JSON은 §7.1 구조 검증과 §9.3 경로 검증을 통과해야 저장된다. 파일 크기 상한(예: 1MB)을 둔다.
- **레퍼런스 조회(§4.5)**: 요청 주소는 코드에 고정한 출처(hanzi-writer-data)만 허용하고, 사용자가 주소를 입력할 수 없게 한다. 글자는 대상 한자 1자(코드포인트 1개)만 받아 URL 인코딩한다. 응답 크기 상한(예: 512KB)을 둔다.

### 9.3. 출력 및 렌더링

- **SVG 경로 주입 방지**: 경로 문자열은 허용 문법만 통과시킨다. 예: `^[MLQCZmlqcz0-9.,\s-]+$`. 경로는 `setAttribute('d', ...)`로만 넣고, `innerHTML`로 SVG 문자열을 조립하지 않는다(경로에 `"/><script>`가 섞이면 XSS가 된다).
- **파일 경로**: 글자로 파일명을 만들 때(`{char}.json`) 대상 한자 리스트에 있는 글자인지 확인하고, 최종 경로가 출력 폴더 안에 있는지 검사한다(`../` 등 경로 탈출 차단).
- **SQL**: 모든 쿼리는 바인딩 파라미터를 쓴다. 문자열 연결로 쿼리를 만들지 않는다.

### 9.4. 데스크톱 앱

- Electron/Tauri 등을 쓸 경우: 렌더러의 Node 통합을 끄고(`nodeIntegration: false`), 컨텍스트 격리(`contextIsolation: true`)와 샌드박스를 켠다. 렌더러에 노출하는 IPC는 필요한 기능만 화이트리스트로 연다.
- CSP를 적용해 외부 스크립트와 인라인 스크립트를 막는다. 외부 네트워크는 레퍼런스 데이터 다운로드 외에는 쓰지 않는다.
- 의존성(Paper.js 등)은 lockfile로 버전을 고정하고, 정기적으로 취약점 점검(`npm audit` 등)을 한다.

### 9.5. 데이터 보호

- `database/chusa1817.db`는 수작업 결과가 담긴 단일 파일이다. 일괄 처리 전 자동 백업을 만들고, 백업은 `VACUUM INTO` 또는 SQLite 백업 API로 만든다(WAL 모드에서 DB 파일만 복사하면 최신 변경이 빠질 수 있다).

## 10. 라이선스 요구사항 (누락 보완)

산출물 배포 전에 반드시 확인해야 한다. 법적 검토가 끝나기 전에는 외부 배포를 하지 않는다.

| 자료 | 라이선스 | 영향 |
| :--- | :--- | :--- |
| Make Me a Hanja 획 데이터 | Arphic Public License | 파생 데이터 배포 시 라이선스 사본 동봉, 출처 표기 |
| 궁서체 TTF | 폰트별 상이 | 많은 상용 폰트가 윤곽 추출·파생 데이터 재배포를 금지한다. 폰트 EULA에서 "글꼴 데이터의 변형·추출" 허용 여부를 확인한다 |
| CHISE/BabelStone IDS | 데이터별 상이 | 출처 표기 조건 확인 |

- `compiled_json.source`에 글자별 데이터 출처를 기록하여, 출처별로 배포 가능 여부를 가려낼 수 있게 한다.

## 11. 미결 사항 (Open Questions)

- 한국 필순의 기준 문헌(교육부 교육용 기초한자 필순 등)을 무엇으로 할지.
- 사용할 궁서체 폰트와 그 라이선스가 윤곽 데이터 재배포를 허용하는지.
- 뷰어 배포 대상(웹, 앱)과 지원 브라우저 범위.
- 사람 검수의 담당자와 검수 기준(합격·불합격 판단 예시).
