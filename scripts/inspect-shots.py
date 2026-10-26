#!/usr/bin/env python3
"""零依赖 PNG 像素分析，用于在没有图形界面/视觉能力时程序化验证界面渲染。

用法：
    python3 scripts/inspect-shots.py <截图目录>

自实现 PNG 解码（仅支持 8bit RGB/RGBA、非隔行），因为环境里没有 PIL。

检查项：
  1. 是否为「有内容」的图（非纯色、非全黑、非全白）
  2. 主窗口：左侧边栏与右侧内容区应有可测量的明暗差异（不同底色）
  3. 悬浮窗：四角应透明（alpha≈0），说明透明窗口生效
  4. 是否存在横向/纵向分隔线（边框），证明布局真的画出来了
  5. 是否出现整块纯黑（防录屏误开会导致 capturePage 全黑）
"""

import sys
import os
import zlib
import struct


def decode_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", f"{path} 不是 PNG"

    pos = 8
    width = height = bitdepth = colortype = None
    idat = bytearray()
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length

        if ctype == b"IHDR":
            width, height, bitdepth, colortype, _, _, interlace = struct.unpack(">IIBBBBB", body)
            assert bitdepth == 8, f"仅支持 8bit，实际 {bitdepth}"
            assert interlace == 0, "不支持隔行 PNG"
        elif ctype == b"IDAT":
            idat += body
        elif ctype == b"IEND":
            break

    channels = {0: 1, 2: 3, 4: 2, 6: 4}[colortype]
    raw = zlib.decompress(bytes(idat))
    stride = width * channels

    out = bytearray(height * stride)
    prev = bytearray(stride)
    src = 0
    for y in range(height):
        f = raw[src]
        src += 1
        line = bytearray(raw[src : src + stride])
        src += stride
        # 反 PNG 滤波
        if f == 1:
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - channels] if i >= channels else 0
                b = prev[i]
                c = prev[i - channels] if i >= channels else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out[y * stride : (y + 1) * stride] = line
        prev = line

    return width, height, channels, out


def px(buf, width, channels, x, y):
    i = (y * width + x) * channels
    if channels == 4:
        return buf[i], buf[i + 1], buf[i + 2], buf[i + 3]
    if channels == 3:
        return buf[i], buf[i + 1], buf[i + 2], 255
    if channels == 1:
        v = buf[i]
        return v, v, v, 255
    return buf[i], buf[i], buf[i], buf[i + 1]  # 灰度+alpha


def region_mean(buf, width, channels, x0, y0, x1, y1):
    r = g = b = 0
    n = 0
    for y in range(y0, y1, 3):
        for x in range(x0, x1, 3):
            pr, pg, pb, _ = px(buf, width, channels, x, y)
            r += pr
            g += pg
            b += pb
            n += 1
    n = max(n, 1)
    return r / n, g / n, b / n


def stats(buf, width, channels, step=2):
    """返回 (平均亮度, 亮度标准差, 深色像素占比, 采样数)

    浅色主题下「唯一颜色数」几乎无区分度（全落在同一色阶），
    因此改用标准差与深色像素占比来判断界面是否真的画出了文字与结构。
    """
    h = len(buf) // (width * channels)
    vals = []
    dark = 0
    n = 0
    for y in range(0, h, step):
        for x in range(0, width, step):
            pr, pg, pb, pa = px(buf, width, channels, x, y)
            # 透明像素不计入亮度统计（悬浮窗圆角外）
            if pa < 32:
                continue
            lum = 0.299 * pr + 0.587 * pg + 0.114 * pb
            vals.append(lum)
            if lum < 120:
                dark += 1
            n += 1
    if not n:
        return 0.0, 0.0, 0.0, 0
    mean = sum(vals) / n
    var = sum((v - mean) ** 2 for v in vals) / n
    return mean, var ** 0.5, dark / n, n


RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  —  {detail}" if detail else ""))


def main():
    shot_dir = sys.argv[1] if len(sys.argv) > 1 else "/tmp/suisi-final"
    files = {}
    for f in sorted(os.listdir(shot_dir)):
        if f.endswith(".png"):
            files[f[:-4]] = os.path.join(shot_dir, f)

    check("截图目录包含各窗口", len(files) >= 4, ", ".join(files.keys()))

    for kind, path in files.items():
        try:
            w, h, ch, buf = decode_png(path)
        except Exception as e:
            check(f"{kind}: 可解码", False, str(e))
            continue

        # 工具条（quizbar）本身就是一条矮横条，不能按普通窗口要求高度 > 100
        min_h = 12 if kind in ('quizbar', 'cursor') else 100
        check(f"{kind}: 可解码为图像", w > 100 and h >= min_h, f"{w}×{h}, {ch} 通道")

        mean, std, dark_ratio, samples = stats(buf, w, ch)
        check(f"{kind}: 非全黑（渲染成功）", mean > 8, f"平均亮度 {mean:.1f}（{samples} 采样）")
        check(
            f"{kind}: 存在深色文字像素（界面已绘制）",
            dark_ratio > 0.001,
            f"深色像素占比 {dark_ratio * 100:.2f}%",
        )
        check(f"{kind}: 亮度有变化（非纯色块）", std > 4, f"亮度标准差 {std:.1f}")

        # 3. 悬浮窗专属：四角透明
        if kind == "floating":
            corners = [
                px(buf, w, ch, 2, 2),
                px(buf, w, ch, w - 3, 2),
                px(buf, w, ch, 2, h - 3),
                px(buf, w, ch, w - 3, h - 3),
            ]
            alphas = [c[3] for c in corners]
            check(
                "floating: 四角透明（透明窗口生效）",
                all(a < 32 for a in alphas),
                f"角落 alpha={alphas}",
            )

        # 4. 主窗口：应存在一条纵向分隔线（证明左侧栏与内容区真的分栏了）。
        #    比「比较两块区域的平均色」稳健得多——内容区大面积是白色卡片时会误判。
        if kind == "main":
            border = (228, 228, 231)  # --ss-border
            found_at = []
            for y in (int(h * 0.30), int(h * 0.75)):
                for x in range(int(w * 0.05), int(w * 0.45)):
                    pr, pg, pb, pa = px(buf, w, ch, x, y)
                    if pa < 32:
                        continue
                    if abs(pr - border[0]) <= 4 and abs(pg - border[1]) <= 4 and abs(pb - border[2]) <= 4:
                        found_at.append(x)
                        break
            check(
                "main: 存在左侧栏纵向分隔线（分栏成立）",
                len(found_at) >= 2,
                f"在 y=30%/75% 处分别于 x={found_at} 找到 --ss-border 色带",
            )

        # 5. 悬浮窗应为两栏：中线附近应有纵向分隔（存在明显暗线或结构变化）
        if kind == "floating":
            mid = w // 2
            col = [px(buf, w, ch, mid, y) for y in range(int(h * 0.2), int(h * 0.8), 5)]
            avg_alpha = sum(c[3] for c in col) / len(col)
            check("floating: 中线区域已绘制（非透明空窗）", avg_alpha > 100, f"中线平均 alpha {avg_alpha:.0f}")

    failed = [r for r in RESULTS if not r[1]]
    print(f"\n===== 汇总：{len(RESULTS) - len(failed)}/{len(RESULTS)} 通过 =====")
    for name, _, detail in failed:
        print(f"  失败：{name} {detail}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
