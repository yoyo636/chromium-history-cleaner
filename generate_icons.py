#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""纯标准库生成插件图标（16/32/48/128 PNG）。

造型：圆角方形背景（Chromium 蓝 #1a73e8）+ 白色历史时钟环 + 两根指针。
依赖：仅 zlib / struct / math / os，无需 Pillow 等第三方库。

用法：python3 generate_icons.py
"""

import math
import os
import struct
import zlib

BG_TOP = (26, 115, 232)  # #1a73e8  渐变顶
BG_BOT = (20, 90, 195)   # 渐变底（略深，给图标一点纵深）
SQ_N = 4.5               # 超椭圆指数 4–5 = iOS 风格连续曲率（区别于普通圆角矩形）
SQ_INSET = 1.5           # squircle 离画布边的内缩（px），避免边缘抗锯齿贴边


def write_png(path, size, pixel_fn):
    """将 pixel_fn(x, y) -> (r, g, b, a) 写入 PNG（RGBA, 8bit）。"""
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # PNG 每行前缀 filter type 0
        for x in range(size):
            r, g, b, a = pixel_fn(x, y)
            raw += bytes((r, g, b, a))
    comp = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", comp)
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def make_pixel_fn(size):
    cx = cy = size / 2.0
    # squircle 的「半轴」：画布半宽减一个内缩
    half = (size - 1) / 2.0 - SQ_INSET
    # 标记加粗：工具栏 16px 下也认得出是「时钟」而不是蓝圆点
    ring_r = size * 0.33
    ring_t = max(1.4, size * 0.10)
    hand_t = max(1.2, size * 0.065)

    def squircle_inside(x, y):
        """超椭圆 |u|^n + |v|^n <= 1 判定（n=4–5 即 iOS 圆角矩形）。"""
        if x < 0 or y < 0 or x >= size or y >= size:
            return False
        u = (x + 0.5 - cx) / half
        v = (y + 0.5 - cy) / half
        if u < -1 or u > 1 or v < -1 or v > 1:
            return False
        return (abs(u) ** SQ_N) + (abs(v) ** SQ_N) <= 1.0

    def bg_color(y):
        """纵向渐变：上亮下暗，给图标一点立体感。"""
        t = (y + 0.5) / size
        r = BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t
        g = BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t
        b = BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t
        return (int(r), int(g), int(b), 255)

    def on_segment(px, py, x0, y0, x1, y1, th):
        dx_ = x1 - x0
        dy_ = y1 - y0
        if dx_ == 0 and dy_ == 0:
            return False
        t = ((px - x0) * dx_ + (py - y0) * dy_) / (dx_ * dx_ + dy_ * dy_)
        t = max(0.0, min(1.0, t))
        qx = x0 + t * dx_
        qy = y0 + t * dy_
        return math.hypot(px - qx, py - qy) <= th

    def pixel(x, y):
        if not squircle_inside(x, y):
            return (0, 0, 0, 0)
        r, g, b, a = bg_color(y)
        px = x + 0.5
        py = y + 0.5
        d = math.hypot(px - cx, py - cy)
        # 白色历史环
        if abs(d - ring_r) <= ring_t:
            return (255, 255, 255, 255)
        # 时针（指 12）+ 分针（指 3）= L 形，3 点整读数
        if on_segment(px, py, cx, cy, cx, cy - ring_r * 0.55, hand_t) or on_segment(
            px, py, cx, cy, cx + ring_r * 0.55, cy, hand_t
        ):
            return (255, 255, 255, 255)
        return (r, g, b, a)

    return pixel


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    icons_dir = os.path.join(here, "icons")
    os.makedirs(icons_dir, exist_ok=True)
    for s in (16, 32, 48, 128):
        out = os.path.join(icons_dir, f"icon{s}.png")
        write_png(out, s, make_pixel_fn(s))
        print("generated", out)


if __name__ == "__main__":
    main()
