#!/usr/bin/env python3
"""Pack a multi-resolution Windows .ico from PNG frames (PNG-compressed entries).

Usage: pack-ico.py <png> [<png> ...] <out.ico>
Each input PNG becomes one icon directory entry; 256px frames are stored with the
ICO width/height byte set to 0 per spec.
"""
import struct
import sys


def png_size(data: bytes) -> tuple[int, int]:
    # PNG: 8-byte signature, then IHDR chunk (4 len + 4 'IHDR' + width(4) + height(4))
    width = struct.unpack(">I", data[16:20])[0]
    height = struct.unpack(">I", data[20:24])[0]
    return width, height


def main() -> int:
    args = sys.argv[1:]
    if len(args) < 2:
        print("usage: pack-ico.py <png> [<png> ...] <out.ico>", file=sys.stderr)
        return 2
    pngs, out = args[:-1], args[-1]

    frames = []
    for path in pngs:
        with open(path, "rb") as fh:
            data = fh.read()
        w, h = png_size(data)
        frames.append((w, h, data))

    count = len(frames)
    header = struct.pack("<HHH", 0, 1, count)  # reserved, type=icon, count
    offset = 6 + 16 * count
    directory = b""
    body = b""
    for (w, h, data) in frames:
        bw = 0 if w >= 256 else w
        bh = 0 if h >= 256 else h
        directory += struct.pack("<BBBBHHII", bw, bh, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
        body += data

    with open(out, "wb") as fh:
        fh.write(header + directory + body)
    print(f"wrote {out} ({count} frames)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
