#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
hanzi_data에 없는 한국 표준 이체자들의
중국(번체/간체) 대응 이체자가 hanzi_data에 존재하는지 확인한다.
"""

import json
import pathlib

BASE       = pathlib.Path("/Users/yutaek/zWorkSpace/zBasis/font2svg")
HANZI_DIR  = BASE / "hanzi_data"
OUT_DIR    = BASE / "font_data_missing"
OUT_DIR.mkdir(exist_ok=True)

# ── 한국 표준 이체자 → 이체자 후보 매핑 ──────────────────────
# 후보: [번체, 간체, 일본, 기타]  순서로 우선 확인
VARIANTS = {
    "倣": ["仿", "倣"],
    "値": ["值"],
    "僞": ["偽", "伪"],
    "卽": ["即"],
    "奬": ["獎", "奖"],
    "屛": ["屏"],
    "峯": ["峰"],
    "愼": ["慎"],
    "慙": ["慚", "惭"],
    "擧": ["舉", "举"],
    "敍": ["敘", "叙"],
    "敎": ["教"],
    "旣": ["既"],
    "査": ["查"],
    "槪": ["概"],
    "氷": ["冰"],
    "汚": ["污"],
    "淸": ["清"],
    "爲": ["為", "为"],
    "畓": [],            # 한국 고유 한자 — 이체자 없음
    "眞": ["真"],
    "硏": ["研"],
    "窓": ["窗", "窓"],
    "竝": ["並", "并"],
    "粧": ["妝", "妆"],
    "絃": ["弦"],
    "緖": ["緒", "绪"],
    "郞": ["郎"],
    "鄕": ["鄉", "乡"],
    "鎭": ["鎮", "镇"],
    "鑛": ["礦", "矿"],
    "隷": ["隸", "隶"],
    "顔": ["顏", "颜"],
    "飜": ["翻"],
    "飮": ["飲", "饮"],
    "鬪": ["鬥", "斗"],
    "𮕩": [],            # CJK Extension G — 이체자 불명
}

# ── 검사 ─────────────────────────────────────────────────────
results = []

for korean_char, candidates in VARIANTS.items():
    found_variants = []
    not_found      = []

    for v in candidates:
        path = HANZI_DIR / f"{v}.json"
        if path.exists():
            # char 필드도 확인
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                actual_char = data.get("char", "")
                found_variants.append({
                    "variant": v,
                    "codepoint": f"U+{ord(v):04X}",
                    "char_field": actual_char,
                    "char_match": actual_char == v,
                })
            except Exception as e:
                found_variants.append({"variant": v, "error": str(e)})
        else:
            not_found.append({"variant": v, "codepoint": f"U+{ord(v):04X}"})

    results.append({
        "korean_char": korean_char,
        "korean_codepoint": f"U+{ord(korean_char[0]):04X}",
        "candidates": candidates,
        "found_in_hanzi_data": found_variants,
        "not_found_in_hanzi_data": not_found,
        "status": (
            "✅ 이체자 있음"  if found_variants else
            "⚠️  후보 없음"   if not candidates else
            "❌ 후보 모두 없음"
        ),
    })

# ── 저장 ─────────────────────────────────────────────────────
out_path = OUT_DIR / "variant_check.json"
out_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

# ── 텍스트 요약 ───────────────────────────────────────────────
lines = ["# 이체자(異體字) 확인 결과", ""]

ok_list    = [r for r in results if r["found_in_hanzi_data"]]
no_list    = [r for r in results if not r["found_in_hanzi_data"] and r["candidates"]]
none_list  = [r for r in results if not r["candidates"]]

lines.append(f"✅ hanzi_data에 이체자 존재: {len(ok_list)}건")
for r in ok_list:
    vs = ", ".join(f"{v['variant']}(U+{ord(v['variant']):04X})" for v in r["found_in_hanzi_data"])
    lines.append(f"  {r['korean_char']} → {vs}")

lines += ["", f"❌ 이체자 후보가 hanzi_data에 없음: {len(no_list)}건"]
for r in no_list:
    lines.append(f"  {r['korean_char']} → 후보: {r['candidates']}")

lines += ["", f"⚠️  이체자 후보 자체가 없음: {len(none_list)}건"]
for r in none_list:
    lines.append(f"  {r['korean_char']} ({r['korean_codepoint']}) — {r['status']}")

summary = "\n".join(lines)
(OUT_DIR / "variant_summary.txt").write_text(summary, encoding="utf-8")
print(summary)
print(f"\n✅ 저장: {out_path}")
