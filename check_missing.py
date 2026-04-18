#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
input.json의 '한자' 목록을 기준으로
  - biaukai_data/{한자}.json 파일 없음
  - hanzi_data/{한자}.json  파일 없음
  - 파일은 있으나 JSON의 'char' 값이 '한자'와 다름
위 세 가지만 확인하여 font_data_missing/ 에 기록한다.
"""

import json
import pathlib

BASE        = pathlib.Path("/Users/yutaek/zWorkSpace/zBasis/font2svg")
INPUT_JSON  = BASE / "input.json"
BIAUKAI_DIR = BASE / "biaukai_data"
HANZI_DIR   = BASE / "hanzi_data"
OUT_DIR     = BASE / "font_data_missing"
OUT_DIR.mkdir(exist_ok=True)

with open(INPUT_JSON, encoding="utf-8") as f:
    entries = json.load(f)

issues_biaukai = []   # biaukai_data 문제
issues_hanzi   = []   # hanzi_data   문제

for entry in entries:
    char = entry["한자"]
    음   = entry.get("음", "")
    id_  = entry.get("id", "")

    # ── biaukai_data 확인 ──────────────────────────────────
    biau_path = BIAUKAI_DIR / f"{char}.json"
    if not biau_path.exists():
        issues_biaukai.append({"id": id_, "음": 음, "한자": char, "reason": "파일 없음"})
    else:
        try:
            data = json.loads(biau_path.read_text(encoding="utf-8"))
            if data.get("char") != char:
                issues_biaukai.append({
                    "id": id_, "음": 음, "한자": char,
                    "reason": f"char 불일치 (파일 내 char={data.get('char')!r})"
                })
        except Exception as e:
            issues_biaukai.append({"id": id_, "음": 음, "한자": char, "reason": f"파싱 오류: {e}"})

    # ── hanzi_data 확인 ───────────────────────────────────
    hanzi_path = HANZI_DIR / f"{char}.json"
    if not hanzi_path.exists():
        issues_hanzi.append({"id": id_, "음": 음, "한자": char, "reason": "파일 없음"})
    else:
        try:
            data = json.loads(hanzi_path.read_text(encoding="utf-8"))
            if data.get("char") != char:
                issues_hanzi.append({
                    "id": id_, "음": 음, "한자": char,
                    "reason": f"char 불일치 (파일 내 char={data.get('char')!r})"
                })
        except Exception as e:
            issues_hanzi.append({"id": id_, "음": 음, "한자": char, "reason": f"파싱 오류: {e}"})

# ── 결과 저장 ─────────────────────────────────────────────
def save(name, data):
    p = OUT_DIR / name
    p.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    return p

save("issues_biaukai.json", issues_biaukai)
save("issues_hanzi.json",   issues_hanzi)

all_issues = (
    [{"source": "biaukai_data", **r} for r in issues_biaukai] +
    [{"source": "hanzi_data",   **r} for r in issues_hanzi]
)
save("all_issues.json", all_issues)

# ── 요약 텍스트 ───────────────────────────────────────────
lines = [
    "# font_data_missing 요약",
    f"총 대상: {len(entries)}",
    "",
    f"## biaukai_data 문제 ({len(issues_biaukai)}건)",
]
for r in issues_biaukai:
    lines.append(f"  [{r['id']}] {r['한자']} ({r['음']})  → {r['reason']}")

lines += ["", f"## hanzi_data 문제 ({len(issues_hanzi)}건)"]
for r in issues_hanzi:
    lines.append(f"  [{r['id']}] {r['한자']} ({r['음']})  → {r['reason']}")

summary = "\n".join(lines)
(OUT_DIR / "summary.txt").write_text(summary, encoding="utf-8")
print(summary)
print(f"\n✅ 저장 완료: {OUT_DIR}")
