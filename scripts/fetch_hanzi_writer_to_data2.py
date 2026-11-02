#!/usr/bin/env python3
"""
input.json 의 한자마다 hanzi-writer-data@2.0 CDN에서 JSON을 받아
애니메이터용 한자 JSON(opnemind_data/佳.json 등)과 동일 스키마로 hanzi_fetch/ 에 저장한다.
이미 hanzi_fetch/{한자}.json 이 있으면 건너뛴다.
"""
import argparse
import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Any, Optional
from urllib.parse import quote

CDN_BASE_DEFAULT = "https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0"


def compact_svg_path(path: str) -> str:
    """opnemind_data 등 기존 스타일에 가깝게: M 284 -> M284 (명령 뒤 불필요 공백 제거)."""
    s = " ".join(path.split())
    s = re.sub(r"([MLHVCSQTZ])\s+(?=[-0-9.])", r"\1", s)
    s = re.sub(r"([mlhvcsqtz])\s+(?=[-0-9.])", r"\1", s)
    return s.strip()


def hanzi_writer_to_record(char: str, hw: dict) -> Optional[dict]:
    strokes = hw.get("strokes")
    if not isinstance(strokes, list) or not strokes:
        return None
    font_outline = []
    for raw in strokes:
        if not isinstance(raw, str):
            continue
        p = compact_svg_path(raw)
        if p:
            font_outline.append(p)
    if not font_outline:
        return None

    rad_indices: list[Any] = hw.get("radStrokes") if isinstance(hw.get("radStrokes"), list) else []
    rad_set: set[int] = set()
    for x in rad_indices:
        try:
            rad_set.add(int(x))
        except (TypeError, ValueError):
            pass

    stroke_outlines = []
    for i, path in enumerate(font_outline):
        stroke_outlines.append(
            {
                "order": i + 1,
                "path": path,
                "radical": 1 if i in rad_set else 0,
            }
        )

    return {
        "char": char,
        "radical": 0,
        "font_outline": font_outline,
        "stroke_outlines": stroke_outlines,
    }


def load_chars(input_path: str) -> list[str]:
    with open(input_path, encoding="utf-8") as f:
        data = json.load(f)
    out = []
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and "한자" in item:
                ch = str(item["한자"]).strip()
                if ch:
                    out.append(ch)
    return sorted(set(out))


def fetch_json(url: str, timeout: float) -> Optional[dict]:
    req = urllib.request.Request(url, headers={"User-Agent": "font2svg-fetch/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    except urllib.error.URLError:
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", "-i", default="input.json")
    parser.add_argument("--outdir", "-o", default="hanzi_fetch")
    parser.add_argument("--cdn-base", default=CDN_BASE_DEFAULT)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--delay", type=float, default=0.05, help="요청 간 초 (CDN 부담 완화)")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    chars = load_chars(args.input)
    os.makedirs(args.outdir, exist_ok=True)

    skipped = 0
    written = 0
    missing = 0
    errors = 0

    for n, char in enumerate(chars, 1):
        out_path = os.path.join(args.outdir, f"{char}.json")
        if os.path.exists(out_path):
            skipped += 1
            continue

        url = f"{args.cdn_base.rstrip('/')}/{quote(char, safe='')}.json"
        if args.dry_run:
            print(f"[dry-run] would fetch {url}")
            continue

        try:
            hw = fetch_json(url, args.timeout)
        except Exception as e:
            print(f"ERROR {char}: {e}")
            errors += 1
            continue

        if hw is None:
            print(f"MISS {char}: 404")
            missing += 1
            continue

        rec = hanzi_writer_to_record(char, hw)
        if not rec:
            print(f"SKIP {char}: no strokes")
            missing += 1
            continue

        with open(out_path, "w", encoding="utf-8") as wf:
            json.dump(rec, wf, ensure_ascii=False, indent=2)
            wf.write("\n")
        written += 1
        if n % 100 == 0:
            print(f"... {n}/{len(chars)} (written={written} skipped={skipped})")

        if args.delay > 0:
            time.sleep(args.delay)

    print(
        f"done: chars={len(chars)} written={written} skipped_existing={skipped} "
        f"missing_or_empty={missing} errors={errors}"
    )


if __name__ == "__main__":
    main()
