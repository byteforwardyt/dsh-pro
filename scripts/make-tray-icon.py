#!/usr/bin/env python3
"""Generate the macOS menu-bar tray template images.

A template image is a black-and-alpha stencil. macOS recolours it for the
light or dark menu bar, so every pixel's RGB must be 0,0,0 and the glyph
must live entirely in the alpha channel. Flagging a filled colour icon as
a template paints a solid block; that is why these files are drawn here
rather than reused from build/icons/.

Regenerate:

  python3 scripts/make-tray-icon.py

Output (next to this comment so a rename is a one-line change):

  shell/src/assets/trayTemplate.png      16x16
  shell/src/assets/trayTemplate@2x.png   32x32

The 1x basename is what shell/src/tray.cjs is handed as iconPath. Electron
picks up the @2x sibling automatically. Both names match TEMPLATE_NAME in
tray.cjs (shell/src/tray.cjs:80).
"""
from __future__ import annotations

import math
import pathlib
import struct
import zlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "shell" / "src" / "assets"
SCALE = 8  # supersample factor; each output pixel averages SCALE*SCALE samples


def png_rgba(width: int, height: int, rgba: bytes) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(tag + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", crc)

    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter None, so a decoder can skip unfiltering
        raw.extend(rgba[y * stride : (y + 1) * stride])
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b"")


def dist_seg(px: float, py: float, x1: float, y1: float, x2: float, y2: float) -> float:
    vx, vy = x2 - x1, y2 - y1
    length = vx * vx + vy * vy
    if length == 0:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * vx + (py - y1) * vy) / length))
    return math.hypot(px - (x1 + t * vx), py - (y1 + t * vy))


def coverage(dist: float, half: float) -> float:
    # 1px AA ramp in output space. dist/half are in 1x pixels.
    return max(0.0, min(1.0, half - dist + 0.5))


def glyph_alpha(x: float, y: float) -> float:
    """Terminal prompt: a chevron plus a block cursor, in 16x16 point space."""
    chev = min(
        dist_seg(x, y, 3.2, 3.1, 9.6, 8.0),
        dist_seg(x, y, 9.6, 8.0, 3.2, 12.9),
    )
    a = coverage(chev, 0.95)
    # Vertical cursor, slightly shorter than the chevron so it reads as a caret
    # rather than a second stroke of the same weight.
    cx, cy = 12.15, 8.0
    hw, hh = 0.85, 2.7
    dx = abs(x - cx) - hw
    dy = abs(y - cy) - hh
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    inside = min(max(dx, dy), 0.0)
    cursor = coverage(outside + inside, 0.5)
    return max(a, cursor)


def render(size: int) -> bytes:
    # Draw in 16-point space regardless of pixel size, then supersample.
    out = bytearray(size * size * 4)
    point = 16.0 / size
    sample = point / SCALE
    for py in range(size):
        for px in range(size):
            total = 0.0
            x0 = px * point
            y0 = py * point
            for sy in range(SCALE):
                for sx in range(SCALE):
                    total += glyph_alpha(x0 + (sx + 0.5) * sample, y0 + (sy + 0.5) * sample)
            alpha = int(round(255 * (total / (SCALE * SCALE))))
            i = (py * size + px) * 4
            out[i : i + 4] = bytes((0, 0, 0, alpha))
    return bytes(out)


def histogram(rgba: bytes) -> tuple[int, int, int]:
    opaque = partial = clear = 0
    for i in range(0, len(rgba), 4):
        a = rgba[i + 3]
        if a == 0:
            clear += 1
        elif a == 255:
            opaque += 1
        else:
            partial += 1
    return opaque, partial, clear


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for size, name in ((16, "trayTemplate.png"), (32, "trayTemplate@2x.png")):
        rgba = render(size)
        (OUT / name).write_bytes(png_rgba(size, size, rgba))
        opaque, partial, clear = histogram(rgba)
        print(f"{name} {size}x{size} opaque={opaque} partial={partial} clear={clear} total={size * size}")


if __name__ == "__main__":
    main()
