#!/usr/bin/env python3
"""shot.py - a screenshot of the real clock, taken over the serial console.

The firmware's `shot` command redraws the face and prints every row as text
(the format is described in main/app_shot.c). This script finds the last
complete shot in a console log, checks its hash, and writes a PNG.

    tools/shot.py capture.log shot.png          from a saved console log
    idf.py -B build/esp32 monitor | tee log     ... type `shot`, quit, then run the line above
    tools/shot.py --port /dev/cu.usbserial-0001 shot.png
                                                send `shot` and read the answer (needs pyserial)
    tools/shot.py --scale 4 --no-mask log out.png

Options: --scale N (default 2 colour, 4 one-bit), --no-mask (keep the corners
of the round face, which the glass hides), --baud N (default 115200).
Only the Python standard library is needed to convert a log.
"""
import argparse
import struct
import sys
import zlib

FNV_OFFSET, FNV_PRIME = 2166136261, 16777619


def decode(text):
    """Return (width, height, kind, face, rows of pixel values) of the last shot in `text`."""
    begin = text.rfind("SHOT BEGIN ")
    if begin < 0:
        raise ValueError("no `SHOT BEGIN` in the log")
    rows, header, hash_ = [], None, FNV_OFFSET
    for line in text[begin:].splitlines():
        words = line.split()
        if len(words) < 3 or words[0] != "SHOT":
            continue  # a log line between the rows
        if words[1] == "BEGIN":
            width, height, kind, face = int(words[2]), int(words[3]), words[4], words[5]
            header = (width, height, kind, face)
        elif words[1] == "END":
            if len(rows) != height:
                raise ValueError("%d of %d rows arrived" % (len(rows), height))
            if int(words[2], 16) != hash_:
                raise ValueError("the hash does not match: the copy is damaged, take it again")
            return header + (rows,)
        else:
            if header is None or int(words[1]) != len(rows):
                raise ValueError("row %s is out of order" % words[1])
            data, row = words[2], []
            if kind == "mono":
                for i in range(0, len(data), 2):
                    byte = int(data[i:i + 2], 16)
                    row.extend((byte >> (7 - bit)) & 1 for bit in range(8))
                row = row[:width]
            else:
                for i in range(0, len(data), 6):
                    row.extend([int(data[i + 2:i + 6], 16)] * int(data[i:i + 2], 16))
            if len(row) != width:
                raise ValueError("row %d has %d pixels" % (len(rows), len(row)))
            for value in row:
                hash_ = ((hash_ ^ (value & 0xFF)) * FNV_PRIME) & 0xFFFFFFFF
                hash_ = ((hash_ ^ (value >> 8)) * FNV_PRIME) & 0xFFFFFFFF
            rows.append(row)
    raise ValueError("no `SHOT END`: the shot is incomplete")


def to_rgb(width, height, kind, face, rows, scale, mask):
    """Rows of pixel values -> bytes of RGB, each pixel `scale` wide."""
    out = bytearray()
    for y in range(height):
        line = bytearray()
        for x in range(width):
            value = rows[y][x]
            if kind == "mono":
                rgb = (255, 255, 255) if value else (16, 16, 16)
            else:
                rgb = (((value >> 11) & 31) * 255 // 31, ((value >> 5) & 63) * 255 // 63, (value & 31) * 255 // 31)
                if mask and face.startswith("round"):
                    dx, dy = 2 * x + 1 - width, 2 * y + 1 - height
                    if dx * dx + dy * dy > width * width:
                        rgb = (38, 40, 44)  # what the round glass hides
            line += bytes(rgb) * scale
        out += line * scale
    return bytes(out)


def write_png(path, rgb, width, height):
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    raw = b"".join(b"\0" + rgb[y * width * 3:(y + 1) * width * 3] for y in range(height))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def capture(port, baud):
    """Send `shot` to the device and return the console text up to SHOT END."""
    try:
        import serial  # pyserial
    except ImportError:
        sys.exit("--port needs pyserial (pip install pyserial); or save the console to a file and convert that")
    with serial.Serial(port, baud, timeout=20) as link:
        link.reset_input_buffer()
        link.write(b"\r\nshot\r\n")
        text = ""
        while "SHOT END" not in text:
            line = link.readline()
            if not line:
                sys.exit("the device stopped answering (is the console on this port?)")
            text += line.decode("utf-8", "replace")
        return text


def main():
    parser = argparse.ArgumentParser(description="Turn the firmware's `shot` output into a PNG.")
    parser.add_argument("log", nargs="?", help="a saved console log ('-' for standard input)")
    parser.add_argument("png", help="the picture to write")
    parser.add_argument("--port", help="take the shot now from this serial port")
    parser.add_argument("--baud", type=int, default=115200)
    parser.add_argument("--scale", type=int, default=0)
    parser.add_argument("--no-mask", action="store_true", help="do not grey out what the round glass hides")
    args = parser.parse_args()

    if args.port:
        text = capture(args.port, args.baud)
    elif args.log in (None, "-"):
        text = sys.stdin.read()
    else:
        with open(args.log, encoding="utf-8", errors="replace") as f:
            text = f.read()
    try:
        width, height, kind, face, rows = decode(text)
    except ValueError as error:
        sys.exit("shot.py: %s" % error)
    scale = args.scale or (4 if kind == "mono" else 2)
    write_png(args.png, to_rgb(width, height, kind, face, rows, scale, not args.no_mask), width * scale, height * scale)
    print("%s: %s %dx%d (%s), scale %d" % (args.png, face, width, height, kind, scale))


if __name__ == "__main__":
    main()
