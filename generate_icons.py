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

BG = (26, 115, 232)  # #1a73e8


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
    radius = size * 0.24  # 圆角半径
    ring_r = size * 0.30  # 历史环半径
    ring_t = max(1.0, size * 0.07)  # 环厚度
    hand_t = max(1.0, size * 0.05)  # 指针厚度

    def rounded_bg(x, y):
        if x < 0 or y < 0 or x >= size or y >= size:
            return (0, 0, 0, 0)
        nx = min(x, size - 1 - x)
        ny = min(y, size - 1 - y)
        if nx >= radius or ny >= radius:
            return (BG[0], BG[1], BG[2], 255)
        dx = radius - nx
        dy = radius - ny
        if dx * dx + dy * dy <= radius * radius:
            return (BG[0], BG[1], BG[2], 255)
        return (0, 0, 0, 0)

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
        r, g, b, a = rounded_bg(x, y)
        if a == 0:
            return (r, g, b, a)
        px = x + 0.5
        py = y + 0.5
        d = math.hypot(px - cx, py - cy)
        # 历史环
        if abs(d - ring_r) <= ring_t:
            return (255, 255, 255, 255)
        # 两根指针（时钟造型）
        if on_segment(px, py, cx, cy, cx + ring_r * 0.55, cy, hand_t) or on_segment(
            px, py, cx, cy, cx, cy - ring_r * 0.55, hand_t
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
