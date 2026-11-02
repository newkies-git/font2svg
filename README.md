# font2svg — 한자 폰트 획순 SVG 추출 및 애니메이터

기초 한자 1,817자의 폰트 윤곽선(`font_outline`) 및 획순 경로(`stroke_outlines`)를 추출·검증·시각화하는 도구 저장소입니다.

## 📁 디렉터리 구조

| 경로 | 설명 |
| :--- | :--- |
| `animator.html` | 웹 기반 한자 획순 비교·편집 애니메이터 뷰어 |
| `input.json` | 추출 대상 기초 한자 1,817자 인덱스 |
| `scripts/` | 폰트 추출(`font_extractor.py`), CDN 수집(`fetch_hanzi_writer_to_data2.py`), 누락/이체자 검증 스크립트 |
| `docs/` | 구현 가이드([`docs/implementation.md`](docs/implementation.md)) 및 운영 절차([`docs/procedures.md`](docs/procedures.md)) |
| `opnemind_data/`, `biaukai_data/`, `hanzi_data/` | 글자별 추출/정제 완료된 JSON 데이터셋 |
| `font_data_missing/` | 누락 및 이체자 대조 리포트 |

