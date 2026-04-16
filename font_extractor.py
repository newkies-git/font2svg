import os
import sys
import json
import csv
import argparse
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen

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
        
        # Get head table for unitsPerEm (scaling)
        units_per_em = font['head'].unitsPerEm
        
        # Format path commands into grouped sub-paths for readability
        raw_path = pen.getCommands()
        import re
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
            
        return {
            "font_outline": new_path_list,
            "unitsPerEm": units_per_em
        }
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
    
    # Smart Merge: Preserve skeletons and radStrokes if they exist
    merged = {
        "char": char,
        "font_outline": new_data["font_outline"],
        "stroke_outlines": existing_data.get("stroke_outlines", []),
        "skeletons": existing_data.get("skeletons", []),
        "radStrokes": existing_data.get("radStrokes", []),
        "unitsPerEm": new_data["unitsPerEm"]
    }
    
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)
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
