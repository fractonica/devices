#!/usr/bin/env python3
"""contact-sheet.py - lay simulator pictures side by side, each under its file name.

    tools/contact-sheet.py out.png  a.png b.png ...        [--cols N] [--zoom Z] [--shrink S]

A review aid for tools/render-matrix.sh: one sheet of a dozen faces is looked
at faster than a dozen files. --zoom enlarges with nearest neighbour (pixels
stay square; use it on the one-bit face to count them); --shrink S takes
every S-th pixel, which brings a simulator picture (2 px per display pixel on
colour, 4 on one bit) back to the display's own pixels: 40 faces to a sheet.
Needs Pillow
(`pip install pillow`); nothing in the build or the tests uses this script.
"""
import argparse
import os
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("contact-sheet.py needs Pillow: pip install pillow")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("files", nargs="+")
    ap.add_argument("--cols", type=int, default=4)
    ap.add_argument("--zoom", type=int, default=1)
    ap.add_argument("--shrink", type=int, default=1)
    args = ap.parse_args()

    tiles = []
    for path in args.files:
        im = Image.open(path).convert("RGB")
        if args.shrink > 1:
            im = im.resize((im.width // args.shrink, im.height // args.shrink), Image.NEAREST)
        if args.zoom > 1:
            im = im.resize((im.width * args.zoom, im.height * args.zoom), Image.NEAREST)
        tiles.append((os.path.splitext(os.path.basename(path))[0], im))

    label, pad = 14, 6
    cell_w = max(im.width for _, im in tiles) + pad
    cell_h = max(im.height for _, im in tiles) + label + pad
    cols = min(args.cols, len(tiles))
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * cell_w + pad, rows * cell_h + pad), (40, 40, 48))
    draw = ImageDraw.Draw(sheet)
    for i, (name, im) in enumerate(tiles):
        x, y = pad + (i % cols) * cell_w, pad + (i // cols) * cell_h
        draw.text((x, y), name, fill=(230, 230, 120))
        sheet.paste(im, (x, y + label))
    sheet.save(args.out)
    print("%s: %d pictures, %d x %d" % (args.out, len(tiles), sheet.width, sheet.height))


if __name__ == "__main__":
    main()
