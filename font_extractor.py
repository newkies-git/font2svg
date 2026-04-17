import os
import json
import argparse
import re
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen


def stroke_outlines_from_font_outline(font_outline):
    """
    font_outline 배열 순서대로 stroke_outlines 항목을 만든다.
    각 항목: order(1부터), path, radical(기본 0 = 거짓).
    """
    if isinstance(font_outline, list):
        out = []
        order = 1
        for seg in font_outline:
            if not isinstance(seg, str):
                continue
            path = seg.strip()
            if not path:
                continue
            out.append({"order": order, "path": path, "radical": 0})
            order += 1
        return out
    if isinstance(font_outline, str):
        path = font_outline.strip()
        return [{"order": 1, "path": path, "radical": 0}] if path else []
    return []


def extract_glyph_path(font_path, char):
    try:
        font = TTFont(font_path)
        glyph_set = font.getGlyphSet()
        
        # Get glyph name from unicode
        cmap = font.getBestCmap()
        char_code = ord(char)
        if char_code not in cmap:
            return None
        
        glyph_name = cmap[char_code]
        glyph = glyph_set[glyph_name]
        
        # Extract path
        pen = SVGPathPen(glyph_set)
        glyph.draw(pen)
        
        raw_path = pen.getCommands()
        commands = re.findall(r'([MLQCVHZm][^MLQCVHZm]*)', raw_path)
        
        new_path_list = []
        current_segment = []
        for cmd in commands:
            cmd = cmd.strip()
            if cmd.startswith('M') and current_segment:
                new_path_list.append(' '.join(current_segment))
                current_segment = [cmd]
            else:
                current_segment.append(cmd)
        if current_segment:
            new_path_list.append(' '.join(current_segment))
            
        return {"font_outline": new_path_list}
    except Exception as e:
        print(f"Error extracting {char}: {e}")
        return None

def save_character_data(char, new_data, data_dir="data"):
    os.makedirs(data_dir, exist_ok=True)
    file_path = os.path.join(data_dir, f"{char}.json")

    existing_data = {}
    if os.path.exists(file_path):
        with open(file_path, 'r', encoding='utf-8') as f:
            existing_data = json.load(f)

    font_outline = new_data["font_outline"]
    stroke_outlines = stroke_outlines_from_font_outline(font_outline)
    char_radical = existing_data.get("radical")
    if char_radical is None or char_radical == "":
        char_radical = 0

    merged = {
        "char": char,
        "radical": char_radical,
        "font_outline": font_outline,
        "stroke_outlines": stroke_outlines,
    }

    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"  -> Saved to {file_path}")

def load_chars_from_file(input_path):
    chars = []
    if not os.path.exists(input_path):
        return chars
        
    try:
        with open(input_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
            if isinstance(data, list):
                # Look for '한자' field in objects, otherwise treat as simple list of strings
                for item in data:
                    if isinstance(item, dict) and '한자' in item:
                        chars.append(item['한자'])
                    elif isinstance(item, str):
                        chars.append(item)
            elif isinstance(data, dict):
                chars = data.get('chars', [])
    except Exception as e:
        print(f"Error loading characters from {input_path}: {e}")
    
    return chars

def main():
    parser = argparse.ArgumentParser(description="Extract SVG paths from font for specific characters.")
    parser.add_argument("--input", "-i", default="input.json", help="Path to input.json containing characters.")
    parser.add_argument("--font", "-f", default="NotoSerifKR-Regular.ttf", help="Path to TTF/OTF font file.")
    parser.add_argument("--outdir", "-o", default="data", help="Output directory for JSON files.")
    args = parser.parse_args()
    
    if not os.path.exists(args.font):
        print(f"Font file {args.font} not found.")
        return

    chars = load_chars_from_file(args.input)
    if not chars:
        print(f"No characters found in {args.input}")
        return

    print(f"Processing {len(chars)} characters using {args.font}...")
    # Optional: Deduplicate chars to avoid redundant work
    unique_chars = sorted(list(set(chars)))
    
    for char in unique_chars:
        print(f"Extracting '{char}'...")
        res = extract_glyph_path(args.font, char)
        if res:
            save_character_data(char, res, args.outdir)
    
    print("\nAll tasks completed.")

if __name__ == "__main__":
    main()
