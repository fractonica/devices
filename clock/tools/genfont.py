#!/usr/bin/env python3
"""genfont.py - turn the ASCII-art font sources into C tables.

    tools/genfont.py                 regenerate both fonts
    tools/genfont.py --check         exit 1 if a generated file is out of date
    tools/genfont.py --preview U+03B7 [font]   print one glyph as it will be drawn

Source:  tools/fonts/<name>.txt     (format: see the top of fui_font_text.txt;
                                     a stroke font: the top of fui_font_line.txt)
Output:  components/fractonica_ui/src/<name>.c

A font with "!subset 1" draws only the glyphs it has: the ASCII it lacks is
written as zero-width records, which the drawer treats as missing (the box).
A font with "!kind strokes" holds polylines instead of bitmaps (fui_font.h).

The table layout is the one fui_font.h documents: a sorted list of code points
and, per glyph, 1 + height bytes: the width, then one byte per row with bit 7
the leftmost column. Python is needed only to run this tool; the generated
files are checked in and the firmware build never runs it.
"""
import math
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = ["fui_font_small", "fui_font_text", "fui_font_line"]

PEN_UP, END = 0xFF, 0xFE


def stroke_points(path, number, line):
    """One drawing command of a stroke glyph -> a list of (x, y) in dots.
    L x0 y0 x1 y1 ...   a polyline
    A cx cy rx ry a0 a1  an elliptical arc, degrees from 3 o'clock, positive
                         clockwise (y grows down); a1 < a0 runs backwards"""
    word = line.split()
    try:
        values = [float(v) for v in word[1:]]
    except ValueError:
        sys.exit(f"{path}:{number}: bad number in {line!r}")
    if word[0] == "L" and len(values) >= 4 and len(values) % 2 == 0:
        return [(values[i], values[i + 1]) for i in range(0, len(values), 2)]
    if word[0] == "A" and len(values) == 6:
        cx, cy, rx, ry, a0, a1 = values
        steps = max(2, int(math.ceil(abs(a1 - a0) / 12.0)))
        return [(cx + rx * math.cos(math.radians(a0 + (a1 - a0) * k / steps)),
                 cy + ry * math.sin(math.radians(a0 + (a1 - a0) * k / steps))) for k in range(steps + 1)]
    sys.exit(f"{path}:{number}: bad command {line!r}")


def parse(path):
    meta, glyphs, current = {}, {}, None
    with open(path, encoding="utf-8") as f:
        for number, raw in enumerate(f, 1):
            line = raw.rstrip("\n")
            if line.startswith(";"):
                continue
            if line.startswith("!"):
                key, value = line[1:].split(None, 1)
                meta[key] = value.strip()
                continue
            if line.startswith("@ "):
                rest = line[2:]
                if rest.startswith("'"):
                    if len(rest) < 3 or rest[2] != "'":
                        sys.exit(f"{path}:{number}: bad quoted code point")
                    cp, rest = ord(rest[1]), rest[3:]
                elif rest.startswith("U+"):
                    word = rest.split()[0]
                    cp, rest = int(word[2:], 16), rest[len(word):]
                else:
                    sys.exit(f"{path}:{number}: bad glyph header")
                if cp in glyphs:
                    sys.exit(f"{path}:{number}: U+{cp:04X} defined twice")
                current = {"top": int(meta["top"]), "rows": [], "width": 0, "line": number}
                for option in rest.split():
                    key, value = option.split("=")
                    if key == "y":
                        current["top"] = int(value)
                    elif key == "w":
                        current["width"] = int(value)
                    else:
                        sys.exit(f"{path}:{number}: unknown option {option}")
                glyphs[cp] = current
                continue
            if not line.strip():
                current = None
                continue
            if current is not None and meta.get("kind") == "strokes" and line[:2] in ("L ", "A "):
                current.setdefault("paths", []).append(stroke_points(path, number, line))
                continue
            if current is None or set(line) - set("#."):
                sys.exit(f"{path}:{number}: unexpected text {line!r}")
            current["rows"].append(line)
    height = int(meta["height"])
    if meta.get("kind") == "strokes":
        return parse_strokes(path, meta, glyphs)
    for cp, g in glyphs.items():
        width = max([g["width"]] + [len(r) for r in g["rows"]])
        if not 1 <= width <= 8:
            sys.exit(f"{path}:{g['line']}: U+{cp:04X} is {width} wide (1..8)")
        if g["top"] + len(g["rows"]) > height:
            sys.exit(f"{path}:{g['line']}: U+{cp:04X} does not fit {height} rows")
        if cp > 0xFFFF:
            sys.exit(f"{path}:{g['line']}: U+{cp:04X} is outside the 16-bit table")
        cell = ["." * width] * g["top"] + [r.ljust(width, ".") for r in g["rows"]]
        g["cell"] = cell + ["." * width] * (height - len(cell))
        g["width"] = width
    check_ascii(path, meta, glyphs)
    return meta, glyphs


def check_ascii(path, meta, glyphs):
    for cp in range(0x20, 0x7F):  # the drawer indexes ASCII without a search
        if cp not in glyphs:
            if meta.get("subset") != "1":
                sys.exit(f"{path}: ASCII U+{cp:04X} is missing")
            glyphs[cp] = {"width": 0, "absent": True}


def parse_strokes(path, meta, glyphs):
    """Stroke glyphs -> records: width, then (x, y) pairs in quarter dots,
    PEN_UP between polylines, END after the last."""
    for cp, g in glyphs.items():
        data = []
        for points in g.get("paths", []):
            if data:
                data.append(PEN_UP)
            for x, y in points:
                qx, qy = int(round(x * 4)), int(round(y * 4))
                if not 0 <= qx < 0xF0 or not 0 <= qy < 0xF0:
                    sys.exit(f"{path}:{g['line']}: U+{cp:04X} has a point outside the cell")
                data += [qx, qy]
        g["data"] = data + [END]
        if not 1 <= g["width"] <= 15:
            sys.exit(f"{path}:{g['line']}: U+{cp:04X} needs w=1..15")
    check_ascii(path, meta, glyphs)
    for g in glyphs.values():
        if g.get("absent"):
            g["data"] = [END]
    return meta, glyphs


def record_of(meta, glyphs):
    if meta.get("kind") == "strokes":
        return 3  # width, then the offset of its points in GLYPHS (low byte first)
    return 1 + int(meta["height"])


def emit(name, meta, glyphs):
    height = int(meta["height"])
    strokes = meta.get("kind") == "strokes"
    record = record_of(meta, glyphs)
    cps = sorted(glyphs)
    out = [
        "/*",
        f" * {name}.c - GENERATED by tools/genfont.py from tools/fonts/{name}.txt.",
        " * Do not edit: change the art and run the tool. Layout: fui_font.h.",
        " */",
        '#include "fui_font.h"',
        "",
        f"static const uint16_t CODEPOINTS[{len(cps)}] = {{",
    ]
    for i in range(0, len(cps), 10):
        out.append("    " + ", ".join(f"0x{cp:04X}" for cp in cps[i:i + 10]) + ",")
    if strokes:
        # 3-byte records (width, offset of the points), then the points of every
        # glyph: (x, y) in quarter dots, 0xFF lifts the pen, 0xFE ends
        offsets, points, base = {}, [], len(cps) * record
        for cp in cps:
            offsets[cp] = base + len(points)
            points += glyphs[cp]["data"]
        if base + len(points) > 0xFFFF:
            sys.exit(f"{name}: the points do not fit 16-bit offsets")
        out += ["};", "",
                "/* width (0: absent), the offset of its points (low byte first); then the points:",
                " * (x, y) in quarter dots of the cell, 0xFF lifts the pen, 0xFE ends */",
                f"static const uint8_t GLYPHS[{base + len(points)}] = {{"]
        for cp in cps:
            g = glyphs[cp]
            label = chr(cp) if 0x20 < cp < 0x7F and chr(cp) not in "\\*/" else ""
            out.append(f"    {g['width']}, 0x{offsets[cp] & 0xFF:02X}, 0x{offsets[cp] >> 8:02X}, /* U+{cp:04X}{(' ' + label) if label else ''} */")
        for i in range(0, len(points), 16):
            out.append("    " + ", ".join(f"0x{v:02X}" for v in points[i:i + 16]) + ",")
    else:
        out += ["};", "", "/* width, then one byte per row (bit 7 = leftmost column); 0 wide: absent */",
                f"static const uint8_t GLYPHS[{len(cps)} * {record}] = {{"]
    for cp in ([] if strokes else cps):
        g = glyphs[cp]
        if g.get("absent"):
            rows = [0] * height
        else:
            rows = [sum(0x80 >> i for i, ch in enumerate(r) if ch == "#") for r in g["cell"]]
        label = chr(cp) if 0x20 < cp < 0x7F and chr(cp) not in "\\*/" else ""
        out.append(f"    {g['width']}, " + ", ".join(f"0x{r:02X}" for r in rows) + f", /* U+{cp:04X}{(' ' + label) if label else ''} */")
    out += [
        "};",
        "",
        f"const fui_font_t {name} = {{",
        "    CODEPOINTS,",
        "    GLYPHS,",
        f"    {len(cps)}, /* glyphs */",
        f"    {height}, /* rows per cell */",
        f"    {meta['top']}, /* first row of a capital */",
        f"    {meta['baseline']}, /* first row below the baseline */",
        f"    {meta['box']}, /* width of the missing-glyph box */",
        f"    {record}, /* bytes per glyph record */",
        f"    {1 if strokes else 0}, /* {'a stroke font' if strokes else 'a bitmap font'} */",
        "};",
        "",
    ]
    return "\n".join(out)


def main(argv):
    if len(argv) >= 2 and argv[1] == "--preview":
        cp = int(argv[2][2:], 16) if argv[2].startswith("U+") else ord(argv[2])
        for name in ([argv[3]] if len(argv) > 3 else FONTS):
            _, glyphs = parse(os.path.join(ROOT, "tools", "fonts", name + ".txt"))
            print(f"{name} U+{cp:04X}:")
            for row in glyphs[cp].get("cell", ["(strokes or absent)"]) if cp in glyphs else ["(missing)"]:
                print("   " + row.replace("#", "##").replace(".", "  ") + "|")
        return 0
    check, stale = "--check" in argv, False
    for name in FONTS:
        meta, glyphs = parse(os.path.join(ROOT, "tools", "fonts", name + ".txt"))
        if meta.get("name") != name:
            sys.exit(f"{name}.txt: !name does not match the file name")
        text = emit(name, meta, glyphs)
        path = os.path.join(ROOT, "components", "fractonica_ui", "src", name + ".c")
        old = open(path, encoding="utf-8").read() if os.path.exists(path) else None
        if check:
            if old != text:
                print(f"{name}.c is out of date: run tools/genfont.py")
                stale = True
        elif old != text:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            size = len(glyphs) * (2 + record_of(meta, glyphs)) + sum(len(g.get("data", [])) for g in glyphs.values())
            print(f"wrote {os.path.relpath(path, ROOT)}: {len(glyphs)} glyphs, {size} bytes")
    return 1 if stale else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
