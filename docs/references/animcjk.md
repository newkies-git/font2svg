# AnimCJK 참고 정보

> **상태: 이 프로젝트의 DB와 로직에서 제거됨 (2026-11-23).** 획 정보의 기준은 NAVER 한자사전이다.
> 이 문서는 제거 전의 사용 방식, 데이터 형식, 측정 결과, 제거 이유, 복원 방법을 남겨 둔 참고 자료다.
> 제거 전 구현은 git 커밋 `7c44c14`(및 그 이전)에서 확인할 수 있다.

## 1. 무엇인가

- 저장소: <https://github.com/parsimonhi/animCJK> (제작: parsimonhi, 저작권 표기 `FM&SH`)
- 목적: 일본 한자·가나, 한국 한자(Hanja), 중국 간체·번체 한자를 **획 단위로 보여 주는** 데이터와 SVG 애니메이션
- 이 프로젝트가 고정해 쓴 커밋: `1c8c8ef45aa9dfe1e1129cb5462ddf59a50a65ce` (`animCJK@1c8c8ef45a`)
- 계보: **Make Me a Hanzi**(<https://github.com/skishore/makemeahanzi>)에서 파생. Makemeahanzi는 다시 Arphic PL KaitiM GB/Big5 폰트(Arphic Technology 제공)를 바탕으로 한다. AnimCJK는 일본·한국·대만 자료를 추가하고 거의 모든 글자를 수정했다(상류 README "Related works").

### 언어별 구성 (상류 README 기준)

| 폴더 | 내용 | 글자 수 |
|---|---|---|
| `svgsJa` | 일본 常用·人名用·漢検 한자 등 | 상류 README 참고 |
| `svgsJaKana` | 히라가나·가타카나 | 177 |
| **`svgsKo`** | **한국 한자 8·7·6·5급, 일부 4급, 기타** | **535** |
| `svgsZhHans` | 중국 간체 상용 7000자 등 | 상류 README 참고 |
| `svgsZhHant` | 대만 상용 4808자 중 일부 등 | 상류 README 참고 |

상류 README의 주의: 같은 유니코드라도 언어마다 **자형·획순·획 방향이 다를 수 있다**(예: 勉). 호환 한자 코드(예: U+FA33 계열)는 다른 언어의 자형을 가리키기도 한다.

## 2. 받아서 쓴 파일

이 프로젝트는 SVG 폴더가 아니라 텍스트 파일 6개만 받았다. 저장소에는 올리지 않았고(`.gitignore`) `database/`에 두었다.

| 파일 | 글자 수 | 크기 |
|---|---|---|
| `graphicsJa.txt` | 7343 | 약 23MB |
| `graphicsZhHant.txt` | 1839 | 약 5.3MB |
| `graphicsKo.txt` | 535 | 약 1.4MB |
| `dictionaryJa.txt` | 7520 | 약 1.4MB |
| `dictionaryZhHant.txt` | 1839 | 약 0.3MB |
| `dictionaryKo.txt` | 535 | 약 0.09MB |

받는 주소: `https://raw.githubusercontent.com/parsimonhi/animCJK/<커밋>/<파일명>` (사람이 보는 주소: `https://github.com/parsimonhi/animCJK/blob/<커밋>/<파일명>`). 응답 상한은 32MB(`ACJK_FILE_LIMIT`)였다. `ZhHans`와 `JaKana`는 받지 않았다.

## 3. 데이터 형식

### graphicsXxx.txt — 한 줄이 한 글자(JSON)

```json
{"character":"近","strokes":["M548,647C610,666 706,715 764,728C…Z", …],"medians":[[[677,786],[731,740],[541,657]], …]}
```

- `strokes`: 획마다 **윤곽 SVG 경로**(곡선 포함, 닫힘). 사람이 그린 것처럼 정점이 적다(획당 약 10개, 전부 곡선).
- `medians`: 획마다 **중심선 점 목록** `[[x, y], …]`.
- 좌표계는 Makemeahanzi와 같다(y가 위로 늘어남). SVG 파일 쪽은 y가 아래로 늘어나며 `y = 900 - svg_y`로 옮긴다(`ACJK_SVG_Y_ORIGIN = 900`).
- 획 번호가 곧 **획순**이다(0부터).

### dictionaryXxx.txt — 한 줄이 한 글자(JSON)

```json
{"character":"近","set":["hanja6","hanja1800a"],"definition":"near, close; approach; intimate","radical":"辶 (辵)","decomposition":"⿺辶斤","acjk":"近⿺斤4辶.4"}
```

- `acjk`: AnimCJK 고유의 **분해식**. 글자 뒤에 획수가 오면 더 쪼개지 않는 글자이고, 구조 기호(IDS: ⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺⿻)가 오면 뒤따르는 부품들로 분해한다(⿲·⿳은 부품 3개, 나머지는 2개).
- 부품은 **그리는 순서**로 적힌다. 그래서 획수를 차례로 누적하면 부품별 획 번호 범위를 알 수 있다.
- 부품 뒤의 `.`은 그 부품이 **부수**임을 뜻한다. `~X`는 같은 부품을 뜻하는 다른 글자, `:`·`::`는 나뉨·겹침 표식이다.
- 라이선스 표기에서 `dictionary` 파일은 Unihan에서 파생된 것으로 구분된다.

## 4. 이 프로젝트에서 쓰던 방식 (제거 전)

### 가져오기·저장

1. `Ja` → `ZhHant` → `Ko` 순으로 파일을 읽어 글자별 색인을 만든다. **뒤의 것이 앞의 것을 덮어쓴다**(Ko가 최우선, Ja가 최하위).
2. 글자 하나의 원본은 `{ strokes, medians, acjk }` JSON 한 줄로 합쳐 `reference_data`에 저장했다.
   - `source = 'ACJK'`, `source_version = 'animCJK@1c8c8ef45a'`, `source_url`은 값을 가져온 파일(`…/graphicsKo.txt` 등), `raw_sha256`은 원문 해시, `found`는 있음 1·없음 0.
3. 파일은 처음 한 번만 받고(`database/`), 글자별 결과는 `reference_data`에 캐시했다.

### 부수 획 추출 (`radicalStrokes`)

`acjk`에서 `.`이 붙은 부품의 획 번호를 `is_radical`로 썼다. 예: `近⿺斤4辶.4` → 5~8번째 획이 부수. 글자 첫머리에 `.`이 있으면 글자 전체가 부수. 구조 기호는 건너뛰며 획수를 누적하고, **합이 가져온 획수와 맞지 않으면 부수를 비웠다.** 당시 한국 파일 535자 중 534자가 해석됐고, 예외는 부수 표시가 없는 `由` 하나였다.

### 레이어·작업 획·API

- 기본 레이어 `acjk`(이름 "AnimCJK", 색 blue, z_index 3, 잠금, 숨김, 불투명도 0.6). 편집은 막고, 작업 획으로 가져온 뒤 고쳤다.
- 작업 획 출처 `strokes.origin = 'ACJK'`, 작업자 `system:acjk`, 이력 문구 "AnimCJK로 교체".
- **일괄 교체 API** `POST /api/apply-acjk`(`applyAcjkBatch`): 이미 있는 글자의 작업 획을 AnimCJK로 바꿨다. `last_modified_by = 'user'`인 글자와 이미 `ACJK`인 글자는 건너뛰었다. UI에는 연결돼 있지 않았다.
- 길잡이 우선순위: 지정 레이어 → 작업 획 → NAVER → MMH → ACJK. IDS 합성의 부품 획 조회는 한때 `MMH → ACJK → NAVER` 순이었고 이후 NAVER 우선으로 바뀌었다.

## 5. 이 프로젝트 데이터에서 측정한 결과 (2026-11-23)

`characters` 1817자 기준.

| 항목 | 값 |
|---|---|
| ACJK 있음 / 없음 | 1810 / 7 |
| ACJK에 없는 글자 | `屛 屢 悅 毁 畓 稅 銳` |
| 파일별 보유 글자 수(우리 글자 기준, 중복 포함) | `graphicsJa` 1802, `graphicsZhHant` 1192, `graphicsKo` 520 |
| 덮어쓰기(Ja → ZhHant → Ko) 후 **실제로 채택된** 출처 파일 | `graphicsJa` **584**, `graphicsZhHant` **706**, `graphicsKo` **520** (합계 1810) |
| NAVER와 **획수가 같음** | 1694 / 1810 (Hanzi와는 1597 / 1776) |
| NAVER와 획수가 다른 글자의 파일 분포 | Ja 83(584자 중), ZhHant 15(706자 중), Ko 18(520자 중) |

- 한국 자료는 **520자(약 29%)** 뿐이고 나머지는 일본(584)·대만(706) 자료에서 왔다.
- NAVER와의 불일치는 일본 자료에서 가장 높다(14%).
- `characters.stroke_count`는 과거 AnimCJK 일괄 교체로 채워져 AnimCJK와 1810/1817자가 일치했다. 제거 때 NAVER 기준으로 바로잡았다(118자 변경).

## 6. 제거한 이유

1. **원칙**: 한국 한자의 획 정보는 NAVER 한자사전이 기준이다. Hanzi(MMH)·AnimCJK와 획순이 다른 글자가 있다.
2. **한국 자료의 범위**: AnimCJK의 한국 데이터는 535자뿐이다. 이 프로젝트의 1817자 대부분은 일본·대만 데이터(획순·자형이 다를 수 있음)로 채워졌다.
3. **오염 사례**: AnimCJK 일괄 교체가 `stroke_count`를 AnimCJK 기준으로 채워 NAVER와 118자가 어긋났다.
4. NAVER 데이터가 1817자 전체에 있게 되어 대체 출처가 필요 없어졌다.

## 7. 제거 내역

### DB (스키마 v4 마이그레이션)

- `reference_data`의 `source = 'ACJK'` 행 삭제(1817행). 마이그레이션 직전에 자동 백업이 만들어진다.
- `character_layers`의 `acjk` 레이어 행 삭제.
- `'system:acjk'` 작업자 기록을 `'system:migration'`으로 바꿈. `strokes.origin = 'ACJK'`가 있으면 `'MANUAL'`로 바꿈.
- `strokes.origin`·`character_layers.kind`의 `CHECK`에서 `'ACJK'` 제거(표를 새로 만들어 옮김).

### 로직

- 레이어 종류·출처 `ACJK`, 레이어 ID `acjk`, 기본 레이어 `acjk`
- AnimCJK 수신·색인·파싱(`fetchAcjk`, `loadAcjk`, `parseAcjkLine`, `radicalStrokes`, `AcjkEntry`), 일괄 교체(`applyAcjkBatch`, `POST /api/apply-acjk`)
- 작업자 `system:acjk`, 이력 문구, 파일 크기 상한 `ACJK_FILE_LIMIT`
- 레이어 우선순위 목록에서의 ACJK

### 남긴 것 (AnimCJK **형식**)

데이터 출처가 아니라 **파일 형식**이라 남겼다.
- `import-svg`: AnimCJK 형식 SVG(`makeSvgsFromGraphics.php`가 만드는 모양)를 승인 전 작업 데이터로 읽는다. 우리가 내보낸 SVG도 읽는다.
- 컴파일이 만드는 애니메이션 SVG는 AnimCJK 방식(획 윤곽을 `clipPath`, 중심선을 점선 애니메이션)이다. 상수 `ACJK_SVG_Y_ORIGIN`(900)은 이 좌표 변환용이다.
- 이미지 → SVG 변환 결과는 같은 형식이라 다시 읽을 수 있다.

### 디스크에 남은 파일

`database/graphics{Ja,ZhHant,Ko}.txt`, `database/dictionary{Ja,ZhHant,Ko}.txt`(합계 약 31MB)는 **삭제하지 않았다.** 더 이상 코드가 읽지 않으므로 필요 없으면 직접 지워도 된다(`.gitignore` 대상이라 저장소에는 없다).

## 8. 다시 쓰고 싶을 때

1. 코드: 커밋 `7c44c14` 시점의 `server/referencePipeline.ts`(`loadAcjk`, `fetchAcjk`, `applyAcjk*`), `server/references.ts`(`parseAcjkLine`, `radicalStrokes`), `server/layers.ts`, `server/layerFetch.ts`를 참고한다.
2. 데이터: 위 6개 파일을 고정 커밋 주소에서 다시 받는다(§2). 한국 자료(`graphicsKo`)만 쓰면 한국 자형·획순 535자가 보장된다.
3. DB: 마이그레이션 v4는 `CHECK`에서 `'ACJK'`를 뺐으므로, 복원하려면 새 마이그레이션(v5 이상)으로 `strokes.origin`·`character_layers.kind`에 값을 되살려야 한다.
4. 복원하더라도 **NAVER 우선** 원칙을 유지해야 한다.

## 9. 라이선스 (상류 `licenses/COPYING.txt` 기준)

- `graphics*` 텍스트 파일과 글자별 SVG 파일: **Arphic Public License** (Arphic Technology). AnimCJK는 Arphic PL KaitiM GB/Big5 폰트, Makemeahanzi, Unihan에서 파생됐다.
- 그 밖의 파일(및 가나·주음부호·획 SVG는 선택적으로): **GNU LGPL v3 이상**.
- `dictionary*`는 Unihan 사전에서 파생됐다.
- 파생 데이터를 배포할 때는 라이선스 표기가 필요하다(`prd.md` 라이선스 표 참고).

## 10. 링크

- 저장소: <https://github.com/parsimonhi/animCJK> · 데모: <https://parsimonhi.github.io/animCJK/>
- 고정 커밋 파일 목록: `https://github.com/parsimonhi/animCJK/tree/1c8c8ef45aa9dfe1e1129cb5462ddf59a50a65ce`
- Makemeahanzi: <https://github.com/skishore/makemeahanzi>
- 상류 README는 데이터 교차검증에 NAVER 한자사전(<https://hanja.dict.naver.com/>)을 한국 한자 참고로 들고 있다.
