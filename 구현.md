# 폰트 획순 애니메이션 구현 가이드 (Implementation Manual)

본 프로젝트는 Noto Serif KR 폰트의 정밀한 디자인을 유지하며, 표준 획순 데이터를 결합하여 고품질 한자 쓰기 애니메이션을 제공합니다.

---

## 1. 아키텍쳐 및 데이터 모델

### 1.1 데이터 분리 구조 (Decoupled Architecture)
유지보수와 확장성을 위해 데이터와 로직을 완전히 분리했습니다.
- **`input.json`**: 전체 데이터베이스 인덱스. 한자, 음, 고유 ID를 포함하여 UI의 사이드바를 구성하고 추출 대상 리스트를 관리합니다.
- **`opnemind_data/{한자}.json`**, **`biaukai_data/{한자}.json`**, **`hanzi_data/{한자}.json`**: 글자별 독립 파일. `animator.html` 사이드바의 **데이터 폴더** 선택으로 셋 중 하나를 불러옵니다(기본값 `opnemind_data`). `hanzi_data`는 구 `data3`(궁서 등)에 해당합니다.
- (레거시) **`data/{한자}.json`**: 초기 설계 문서 기준 폴더명.

### 1.2 데이터 스케마 (JSON Schema)
애니메이터·추출 파이프라인에서 쓰는 **획 단위** 스키마 예시는 [`opnemind_data/佳.json`](opnemind_data/佳.json) 과 같습니다.

```json
{
  "char": "佳",
  "radical": 0,
  "font_outline": ["M...Z", "..."],
  "stroke_outlines": [
    { "order": 1, "path": "M...Z", "radical": 0 }
  ]
}
```
- `font_outline`: 획별 SVG path 문자열 배열(또는 단일 문자열).
- `stroke_outlines`: 획 순서(`order`), 해당 획 `path`, 부수 획 여부 등(`radical`).
- 일부 구버전 문서의 `skeletons` 필드는 본 저장소의 현재 애니메이터 흐름과 다를 수 있습니다.

---

## 2. 추출 도구 (Font Extractor)

`font_extractor.py`는 Python 환경에서 동작하며 다음과 같은 핵심 기능을 수행합니다.
- **FontTools Pen**: `SVGPathPen`을 사용하여 폰트의 베지어 곡선을 SVG 경로로 변환합니다.
- **TTC 지원**: `--font-family` / `--font-index` / `--list-faces` 로 TrueType Collection에서 면(face) 선택.
- **좌표계**: 폰트 디자인 공간(UPM)에 따른 좌표가 그대로 path에 들어가며, 애니메이터에서 스케일·오프셋으로 배치합니다.
- **출력**: `char`, `radical`, `font_outline`, `stroke_outlines` 형태로 지정 `--outdir`(기본 **`font_ext_data`**)에 저장합니다. 애니메이터가 쓰는 `opnemind_data` 등과는 별도이므로, 워크플로에 맞게 `--outdir`를 바꾸거나 생성 후 복사합니다.

**hanzi-writer-data → `hanzi_fetch`**: `fetch_hanzi_writer_to_data2.py`는 `input.json`의 한자를 CDN `hanzi-writer-data@2.0`에서 받아 위와 동일 스키마로 기본 **`hanzi_fetch/`**에 쓰며, **기존 `hanzi_fetch/{한자}.json`이 있으면 건너뜁니다.** (`biaukai_data` 등 다른 폴더는 `--outdir`로 지정.)

---

## 3. 애니메이터 엔진 (Animator Interface)

`animator.html`은 고성능 SVG 렌더링 및 인터랙티브 제어 기능을 제공합니다.

- **데이터 폴더**: `opnemind_data` / `biaukai_data` / `hanzi_data` 선택 가능(기본 `opnemind_data`). 각 폴더의 `{한자}.json`을 fetch하여 캐시합니다.
- **비교 모드**: 동일 한자에 대해 세 폴더의 윤곽을 한 viewBox에 겹쳐 색으로 비교합니다.

### 3.1 좌표 시스템 (Visualized Grid)
- **viewBox**: `-500 -500 1000 1000` (원점 (0,0) 중심 정렬)
- **가시화**: 중심축(Axes), 100단위 격자(Grid), 좌표 라벨을 통해 데이터의 배치를 실시간으로 확인 가능합니다.
- **Overflow 처리**: 경계면의 좌표가 잘리지 않도록 `overflow: visible` 설정을 적용했습니다.

### 3.2 인터랙티브 제어 (Interactive Controls)
- **Character Scale**: 글자 크기를 0.5x ~ 1.0x로 실시간 조절 (기본값 0.90x).
- **Font Opacity**: 배경 디자인의 투명도를 0% ~ 100%로 조절하여 획순 집중도 조정.
- **Vertical Offset**: 글자의 베이스라인(Baseline) 높이를 조절 (기본값 870).

### 3.3 애니메이션 메커니즘
- **SVG Masking**: 폰트 본체 레이어 위에 획순을 따라가는 마스크 레이어를 얹어 "획이 그려지는" 효과를 구현합니다.
- **Dash-offset 계산**: `getTotalLength()`를 통해 각 획의 정확한 길이를 계산하고, 순차적(Sequential)으로 `stroke-dashoffset`을 `0`으로 변화시킵니다.

---

## 4. 디자인 시스템 (UI/UX)
- **Premium Dark Mode**: 어두운 배경(#0f172a)에서 획의 움직임이 더욱 돋보이도록 설계했습니다.
- **Searchable Sidebar**: 1,817개의 방대한 한자를 자음/한자 검색을 통해 즉시 찾을 수 있는 사이드바를 제공합니다.
- **Responsive Layout**: 사이드바와 메인 스테이지가 조화롭게 배치된 현대적인 웹 대시보드 형태입니다.

---
*Created by Antigravity*
