# Hanja Stroke Master Studio

궁서체 TTF 윤곽을 획 단위로 나누고, 필순 애니메이션용 정적 데이터(`compiled_json`·애니메이션 SVG)를 만드는 로컬 어드민 도구입니다. 기획 배경과 요구사항은 [prd.md](prd.md)에 있습니다.

## 시작하기

필요한 것: Node 24 이상(`node:sqlite`와 TypeScript 직접 실행을 쓴다. 개발은 Node 26에서 했다).

```bash
cd app
npm ci
npm run dev        # http://localhost:5173 (API는 Vite 개발 서버가 같이 제공)
```

- 궁서체 폰트는 `app/fonts/Gungseouche.ttf`에 직접 두어야 한다(라이선스 때문에 저장소에 포함하지 않는다).
- 대상 글자 목록은 화면의 업로드로 등록한다(예: `docs/input_1817.json`, 항목은 `{ "한자", "음", "구분" }`).
- DB(`database/chusa1817.db`)는 첫 실행에 자동으로 만들고 마이그레이션한다. 저장소에는 포함하지 않는다.
- API는 같은 컴퓨터(loopback)에서 온 요청만 받는다(그 외는 403). 잘못된 주소는 400, 처리 중 예외는 500으로 답하며 서버는 계속 동작한다.

## 명령

| 명령 | 하는 일 |
| :--- | :--- |
| `npm run dev` | 개발 서버 |
| `npm run build` | 화면 빌드(DB를 열지 않는다. DB는 개발 서버를 켤 때만 연다) |
| `npm run typecheck` | `vue-tsc` 타입 검사(`noUnusedParameters`·`noImplicitReturns` 등 엄격 옵션 사용) |
| `npm test` | `node:test` 테스트 |
| `npm run lint` | ESLint(버그 가능성이 있는 패턴만 검사, 형식 규칙 없음. `.ts`에는 기다리지 않은 Promise를 잡는 타입 기반 규칙 포함) |
| `npm run knip` | 안 쓰는 파일·export·의존성 검사 |
| `npm run backup` | `database/chusa1817.backup-<시각>.db`로 DB 백업 |
| `npm run prefetch:refs` | 참고 획순(Hanzi → 네이버)을 전 글자 내려받아 `reference_data`에 저장한다. 받은 글자는 건너뛰므로 끊겨도 이어서 받는다. `-- --retry-missing`으로 "없음"으로 기록된 글자를 다시 받고, `-- mmh` 또는 `-- naver`로 출처를 고른다 |
| `npm run bench:extract` | 궁서체 윤곽을 참고 중심선(획순 NAVER, 모양 Hanzi)으로 나눈 결과의 품질 지표(정점 수·곡선 비율·중심선 꺾임/되돌림·파편·띠 대체)를 잰다. DB는 읽기만 하며 `-- --out 파일.json`, `-- --sheet 접촉시트.svg`를 줄 수 있다. 기준값은 `docs/benchmarks/extract-baseline.json` |

CI(`.github/workflows/ci.yml`)는 타입 검사·lint·knip·테스트·빌드를 돌린다.

## 구조

```text
app/
  shared/   서버와 화면이 함께 쓰는 코드: 타입, 상수, 경로·윤곽 분할 알고리즘(strokeCut), 레이어 종류,
            격자 겹침(IoU) 맞춤 기반(fitCore), 획 편집 계산(strokeOps·vectorEdit), 참고 획순 짝짓기(strokeOrder)
  server/   API와 저장소(node:sqlite). 화면 코드를 가져오지 않고 shared만 쓴다
            apiMiddleware(Vite 연결 어댑터), routes·ollamaRoutes(라우터)·routeKit, layers(레이어 구성)·layerWrites(레이어 저장),
            layerFetch(참고 레이어 수신)·layerApply(작업 획에 적용), referencePipeline·referenceMerge(참고 데이터),
            registration(참고 중심선을 궁서체에 등록), characterWrites(글자 행 갱신),
            ollamaChat·ollamaTools·strokeEdits(Ollama 채팅), extractMetrics(추출 품질 지표)
  src/      Vue 화면: components(표시), composables(상태·동작), lib(순수 계산)
  scripts/  보조 스크립트(DB 백업, 참고 데이터 미리 받기, 추출 품질 측정)
  tests/    node:test 테스트
database/   작업 DB, 내려받은 공개 데이터(IDS)와 백업 — Git 추적 제외
docs/       입력 목록, 코드 분석(codebase-logic-analysis.md), 품질 측정 결과(benchmarks/), 참고 자료 조사(references/)
output/     컴파일 산출물(`compiled/<글자>.json`, `.svg`). 개발 서버를 켤 때 만들어지며 — Git 추적 제외
```

### 레이어

한 글자는 여러 레이어로 보인다: 궁서체(FONT), 획 윤곽(OUTLINE, 궁서체 윤곽 ↔ 획 매핑), 외부 레퍼런스(Hanzi MMH · 네이버 획순. 획순은 네이버, 획의 굵기·시작·끝·꺾임은 Hanzi가 기준이며, AnimCJK는 참고 문서만 `docs/references/animcjk.md`에 둔다), 작업 획(STROKES), 중심선·번호 오버레이, 사용자 레이어(CUSTOM). 레퍼런스 종류는 `shared/layerKind.ts`의 `REFERENCE_KINDS` 한 곳에서 정의한다. 잠긴 레이어의 내용 저장은 서버도 거부한다.

### 획 추출

궁서체 윤곽을 참고 중심선(획순은 네이버, 모양은 Hanzi)으로 나눌 때 `server/geometry.ts`가 다음을 거친다. 참고 중심선을 글자 전체 bbox로 맞춘 뒤, 윤곽을 못 찾은 획이 있으면 획마다 이동·확대·회전·기울임을 찾아 등록(`registration.ts`)하고 미매핑이 더 적은 쪽을 쓴다. 다른 획과 만나는 획의 시작·끝은 상대 획 폭의 1/2~2/3만큼 겹친다. 래스터 윤곽은 모서리를 살린 3차 베지어로 맞추고(`strokeCut/curveFit.ts`), 다른 획의 잉크가 잘못 붙은 파편은 지우고 한 획에서 떨어져 나간 조각은 마주 보는 변으로 이어 한 덩어리로 합친다. 복원 중심선이 급히 꺾였으면 윤곽 안에 있는 참고선으로 바꾸거나 꺾임을 깎고, 중심선 끝은 윤곽 끝까지 늘린다. 같은 잣대로 전후를 비교하려면 `npm run bench:extract`를 쓴다.

### Ollama 채팅

화면 우측 아래 "로컬 Ollama"의 **채팅** 버튼으로 채팅 창을 연다(로컬 Ollama가 켜져 있어야 한다. 요청은 loopback 주소의 Ollama로만 간다). 모델은 도구 호출을 지원해야 한다(기본 `qwen3.5:9b`).

- **일반 채팅**: 모델이 `list_characters`·`get_character` 도구로 DB의 글자·획 정보를 직접 조회해 답한다. 데이터는 바꾸지 않는다.
- **데이터 수정 채팅**: 위 조회에 더해 `propose_stroke_edits`로 수정을 *제안*할 수 있다. 제안은 DB를 바꾸지 않고, 채팅 창의 **적용**을 눌러야 `POST /api/ollama/apply-edits`가 작업 획에 반영한다. 제안은 부수 지정·기필/수필 모양·중심선 반전·순서 이동·삭제·병합이며, 서버가 제안과 적용 때 두 번 검증한다. 번호가 밀리는 수정(이동·삭제·병합)은 한 번에 하나만 받고, 잠긴 레이어에는 적용하지 않는다.
- 승인된 글자는 적용에 이력이 남아 실행 취소할 수 있다. 승인 전 글자는 작업 데이터를 바로 덮어쓰므로 되돌릴 수 없다. 지금 보고 있는 글자에 저장하지 않은 편집이 있으면 적용이 막힌다.
- IDS 추론·합성(`ollama-ids`)과 궁서체 획 분리(`ollama-split`)는 API와 다이얼로그 코드만 남아 있고 화면에서는 열 수 없다.

### 데이터와 마이그레이션

- 스키마는 `PRAGMA user_version`으로 버전을 관리하고(`server/schema.ts`의 `MIGRATIONS`), 마이그레이션 전에 `database/chusa1817.before-v<버전>-<시각>.db`로 자동 백업한다.
- 앱이 아는 버전보다 높은 DB는 열지 않는다.
- 여러 레이어 저장은 한 요청·한 트랜잭션이라 일부만 저장되지 않는다.

### 화면 폰트

화면 폰트(Pretendard 가변 폰트, OFL-1.1)는 외부 CDN이 아니라 `app/public/fonts/`의 파일을 쓴다. 외부 CSS는 응답이 걸리면 스크립트 실행까지 막아 앱이 뜨지 않을 수 있고, 이 도구는 DB·API가 모두 로컬이라 화면도 오프라인에서 떠야 한다. 라이선스 전문은 `app/public/fonts/Pretendard-OFL.txt`에 있다. 글꼴을 바꾸려면 `app/src/style.css`의 `@font-face`와 `--font-sans`를 함께 고친다.

### TypeScript 버전

`package.json`은 `typescript`를 `npm:@typescript/typescript6`로 둔다. `vue-tsc`(현재 최신 3.3.x)가 TypeScript 7에서 없어진 JS API에 의존해 TS 7로는 동작하지 않기 때문이다. `vue-tsc`가 TS 7을 지원하면 이 별칭을 걷어낸다.

## 테스트

`npm test`는 임시 디렉터리의 DB로 서버(저장·마이그레이션·라우터·컴파일 출력·SVG 파서·참고 데이터 합성·Ollama 채팅 도구 루프와 수정 적용)와 공유 엔진(획 분할·곡선 맞춤·파편 정리·조각 병합·획순 짝짓기)과 화면의 순수 로직(변환·자동 맞춤·편집 컴포저블·단축키·칼 분할 뒤 보이는 획 수·이미지 이진화와 윤곽 추적)을 검사한다. Ollama는 가짜 `fetch`로 대신한다. 브라우저 화면은 자동으로 검증하지 않는다.
