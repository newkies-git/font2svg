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
- API는 같은 컴퓨터(loopback)에서 온 요청만 받는다.

## 명령

| 명령 | 하는 일 |
| :--- | :--- |
| `npm run dev` | 개발 서버 |
| `npm run build` | 화면 빌드 |
| `npm run typecheck` | `vue-tsc` 타입 검사 |
| `npm test` | `node:test` 테스트 |
| `npm run lint` | ESLint(버그 가능성이 있는 패턴만 검사, 형식 규칙 없음) |
| `npm run knip` | 안 쓰는 파일·export·의존성 검사 |
| `npm run backup` | `database/chusa1817.backup-<시각>.db`로 DB 백업 |

CI(`.github/workflows/ci.yml`)는 타입 검사·lint·knip·테스트·빌드를 돌린다.

## 구조

```text
app/
  shared/   서버와 화면이 함께 쓰는 코드: 타입, 상수, 경로·윤곽 분할 알고리즘(strokeCut), 레이어 종류
  server/   API와 저장소(node:sqlite). 화면 코드를 가져오지 않고 shared만 쓴다
  src/      Vue 화면: components(표시), composables(상태·동작), lib(순수 계산)
  scripts/  보조 스크립트(DB 백업)
  tests/    node:test 테스트
database/   작업 DB, 내려받은 공개 데이터(IDS, AnimCJK)와 백업 — Git 추적 제외
output/     컴파일 산출물(`compiled/<글자>.json`, `.svg`) — Git 추적 제외
```

### 레이어

한 글자는 여러 레이어로 보인다: 궁서체(FONT), 획 윤곽(OUTLINE, 궁서체 윤곽 ↔ 획 매핑), 외부 레퍼런스(Hanzi MMH · AnimCJK · 네이버 획순), 작업 획(STROKES), 중심선·번호 오버레이, 사용자 레이어(CUSTOM). 레퍼런스 종류는 `shared/layerKind.ts`의 `REFERENCE_KINDS` 한 곳에서 정의한다. 잠긴 레이어의 내용 저장은 서버도 거부한다.

### 데이터와 마이그레이션

- 스키마는 `PRAGMA user_version`으로 버전을 관리하고(`server/schema.ts`의 `MIGRATIONS`), 마이그레이션 전에 `database/chusa1817.before-v<버전>-<시각>.db`로 자동 백업한다.
- 앱이 아는 버전보다 높은 DB는 열지 않는다.
- 여러 레이어 저장은 한 요청·한 트랜잭션이라 일부만 저장되지 않는다.

### 화면 폰트

화면 폰트(Pretendard 가변 폰트, OFL-1.1)는 외부 CDN이 아니라 `app/public/fonts/`의 파일을 쓴다. 외부 CSS는 응답이 걸리면 스크립트 실행까지 막아 앱이 뜨지 않을 수 있고, 이 도구는 DB·API가 모두 로컬이라 화면도 오프라인에서 떠야 한다. 라이선스 전문은 `app/public/fonts/Pretendard-OFL.txt`에 있다. 글꼴을 바꾸려면 `app/src/style.css`의 `@font-face`와 `--font-sans`를 함께 고친다.

### TypeScript 버전

`package.json`은 `typescript`를 `npm:@typescript/typescript6`로 둔다. `vue-tsc`(현재 최신 3.3.x)가 TypeScript 7에서 없어진 JS API에 의존해 TS 7로는 동작하지 않기 때문이다. `vue-tsc`가 TS 7을 지원하면 이 별칭을 걷어낸다.

## 테스트

`npm test`는 임시 디렉터리의 DB로 서버(저장·마이그레이션·라우터·컴파일 출력·SVG 파서)와 화면의 순수 로직(변환·자동 맞춤·편집 컴포저블·단축키)을 검사한다. 브라우저 화면은 자동으로 검증하지 않는다.
