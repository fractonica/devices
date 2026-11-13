#!/usr/bin/env python3
"""png-compress.py - rewrite PNG files with real compression, in place.

The simulator's PNG writer (sim/src/sim_png.c) is deliberately tiny and
stores pixels uncompressed: a 480 x 480 shot is 690 kB. That is fine for
sim/out/ (never committed); the few pictures README.md shows are kept in the
repository (docs/), so `make pictures` passes them through this script (about 10 kB
each afterwards). The pixels are untouched. Standard library only.

    tools/png-compress.py file.png [more.png ...]
"""
import struct
import sys
import zlib


def recompress(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("%s is not a PNG" % path)
    chunks, pixels, at = [], b"", 8
    while at < len(data):
        length, kind = struct.unpack(">I4s", data[at:at + 8])
        body = data[at + 8:at + 8 + length]
        at += 12 + length
        if kind == b"IDAT":
            pixels += body
        else:
            chunks.append((kind, body))
    packed = zlib.compress(zlib.decompress(pixels), 9)
    out = b"\x89PNG\r\n\x1a\n"
    for kind, body in chunks:
        if kind == b"IEND":
            out += struct.pack(">I", len(packed)) + b"IDAT" + packed + struct.pack(">I", zlib.crc32(b"IDAT" + packed))
        out += struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))
    with open(path, "wb") as f:
        f.write(out)
    return len(data), len(out)


for name in sys.argv[1:]:
    before, after = recompress(name)
    print("%s: %d -> %d bytes" % (name, before, after))
