"""Draws the app icon (rounded black tile, green gradient ring + tag mark) -> icon.png and icon.ico. Pure Python."""
import math, struct, zlib, os

N = 256
here = os.path.dirname(os.path.abspath(__file__))


def mix(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))


def px(x, y):
    # rounded square mask
    r = 56
    cx, cy = abs(x - N / 2 + .5), abs(y - N / 2 + .5)
    hx = N / 2 - 4
    dx, dy = max(cx - (hx - r), 0), max(cy - (hx - r), 0)
    if cx > hx or cy > hx or dx * dx + dy * dy > r * r:
        return (0, 0, 0, 0)
    bg = mix((14, 14, 14), (24, 24, 24), (x + y) / (2 * N))
    # topographic hint: faint concentric wobbly rings
    d = math.hypot(x - 70, y - 60) + 8 * math.sin(x / 19.0) + 6 * math.sin(y / 14.0)
    if abs((d % 22) - 11) < 0.9:
        bg = (34, 34, 34)
    # green ring
    d2 = math.hypot(x - N / 2, y - N / 2)
    t = (x + y) / (2 * N)
    g = mix((26, 168, 75), (59, 230, 127), t)
    if 62 <= d2 <= 84:
        return g + (255,)
    # inner play-like notch (music/tag mark): a rounded triangle
    ax, ay = x - N / 2 + 8, y - N / 2
    if ax > -20 and abs(ay) < (34 - (ax + 20) * 0.78) and ax < 36:
        return g + (255,)
    return bg + (255,)


raw = b"".join(b"\x00" + b"".join(bytes(px(x, y)) for x in range(N)) for y in range(N))


def chunk(t, d):
    c = struct.pack(">I", len(d)) + t + d
    return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)


png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", N, N, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")
open(os.path.join(here, "icon.png"), "wb").write(png)
ico = struct.pack("<HHH", 0, 1, 1) + struct.pack("<BBBBHHII", 0, 0, 0, 0, 1, 32, len(png), 22) + png
open(os.path.join(here, "icon.ico"), "wb").write(ico)
print("icons written")
