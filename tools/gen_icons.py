#!/usr/bin/env python3
"""生成 PWA 图标 PNG。

本机没有 rsvg/inkscape/cairosvg，所以不走 SVG 转换，直接用 zlib+struct 写 PNG。
图形保持简单（无文字，避免字体依赖）：深色圆角底 + 两条竖条（蓝=日语/紫=声乐）+ 绿色波形。
"""
import struct, zlib, math, os

W_BG = (0x12, 0x14, 0x1A)
C_LINE = (0x2C, 0x31, 0x40)
C_BLUE = (0x5B, 0x8C, 0xFF)
C_PURPLE = (0xA3, 0x7B, 0xFF)
C_GREEN = (0x3E, 0xCF, 0x8E)


def make(size):
    px = [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]
    r = size * 0.22          # 圆角半径
    s = size / 192.0         # 相对 192 的缩放

    def inside_round_rect(x, y):
        # 圆角矩形的覆盖判定：四角用圆心距离判断
        for cx, cy in ((r, r), (size - r, r), (r, size - r), (size - r, size - r)):
            if (x < r and cx == r or x > size - r and cx == size - r) and \
               (y < r and cy == r or y > size - r and cy == size - r):
                return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
        return True

    # 底 + 描边
    for y in range(size):
        for x in range(size):
            if not inside_round_rect(x + 0.5, y + 0.5):
                continue
            edge = min(x, y, size - 1 - x, size - 1 - y)
            px[y][x] = (*C_LINE, 255) if edge < max(1, size // 96) else (*W_BG, 255)

    def blend(x, y, color, a):
        if not (0 <= x < size and 0 <= y < size):
            return
        if a <= 0:
            return
        a = min(1.0, a)
        br, bg, bb, ba = px[y][x]
        if ba == 0:
            return
        px[y][x] = (
            int(br * (1 - a) + color[0] * a),
            int(bg * (1 - a) + color[1] * a),
            int(bb * (1 - a) + color[2] * a),
            255,
        )

    def disc(cx, cy, rad, color):
        for y in range(int(cy - rad) - 1, int(cy + rad) + 2):
            for x in range(int(cx - rad) - 1, int(cx + rad) + 2):
                d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
                blend(x, y, color, rad - d + 0.5)

    def bar(cx, y0, y1, w, color):
        rad = w / 2
        disc(cx, y0, rad, color)
        disc(cx, y1, rad, color)
        for y in range(int(y0), int(y1) + 1):
            for x in range(int(cx - rad) - 1, int(cx + rad) + 2):
                blend(x, y, color, rad - abs(x + 0.5 - cx) + 0.5)

    def polyline(pts, w, color):
        rad = w / 2
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            n = int(max(abs(x1 - x0), abs(y1 - y0)) * 2) + 2
            for i in range(n + 1):
                t = i / n
                disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, rad, color)

    # 两条竖条：左蓝（日语）右紫（声乐），高低不同表示两条并行的线
    bar(62 * s, 44 * s, 100 * s, 15 * s, C_BLUE)
    bar(130 * s, 56 * s, 100 * s, 15 * s, C_PURPLE)
    # 绿色波形：音高轨迹
    pts = [(24, 132), (42, 132), (54, 116), (66, 152), (80, 124), (94, 140),
           (108, 118), (122, 146), (136, 126), (150, 134), (168, 122)]
    polyline([(x * s, y * s) for x, y in pts], 7 * s, C_GREEN)

    raw = b''.join(b'\x00' + b''.join(struct.pack('4B', *px[y][x]) for x in range(size)) for y in range(size))

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


here = os.path.dirname(os.path.abspath(__file__))
for sz in (192, 512):
    p = os.path.join(here, '..', 'icons', f'icon-{sz}.png')
    with open(p, 'wb') as f:
        f.write(make(sz))
    print(f'{os.path.basename(p)}  {os.path.getsize(p)} bytes')
