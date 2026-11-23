#!/usr/bin/env python3
"""Иконка DSH Federation: тёмный фон, градиентная сеть из трёх узлов.

Рисует legacy (48..192 px) и adaptive foreground (108dp: 108..432 px).
Проверка: bbox глифа внутри safe zone 66/108, черновик в docs/.
"""
import math, os, sys
from PIL import Image, ImageDraw, ImageFilter

ACCENT = (91, 140, 255)
ACCENT2 = (160, 107, 255)
SS = 4  # суперсемплинг

def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

def draw_glyph(draw, size, orbit, dot, line, center=(0.5, 0.5)):
    cx, cy = size * center[0], size * center[1]
    pts = [(cx + size * orbit * math.sin(a), cy - size * orbit * math.cos(a))
           for a in (0, 2 * math.pi / 3, 4 * math.pi / 3)]
    # градиентные связи: от синего к фиолетовому по индексу
    pairs = [(0, 1), (1, 2), (2, 0)]
    for k, (i, j) in enumerate(pairs):
        col = lerp(ACCENT, ACCENT2, k / 2)
        draw.line([pts[i], pts[j]], fill=col + (235,), width=max(1, round(size * line)))
    for i, (x, y) in enumerate(pts):
        r = size * dot
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(236, 242, 253, 255))
        rr = r * 0.42
        draw.ellipse([x - rr, y - rr, x + rr, y + rr], fill=lerp(ACCENT, ACCENT2, i / 2) + (255,))

def background(size):
    n = size * SS
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    # диагональный тёмный градиент
    for y in range(n):
        t = y / max(1, n - 1)
        col = lerp((17, 27, 48), (8, 12, 22), t)
        ImageDraw.Draw(img).line([(0, y), (n, y)], fill=col + (255,))
    # свечение в центре
    glow = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    cx = n / 2
    for r in range(int(n * 0.46), 0, -2):
        a = int(52 * (1 - r / (n * 0.46)) ** 1.5)
        gd.ellipse([cx - r, cx - r, cx + r, cx + r], fill=ACCENT + (a,))
    img = Image.alpha_composite(img, glow.filter(ImageFilter.GaussianBlur(n * 0.02)))
    return img

def legacy(size):
    img = background(size)
    draw = ImageDraw.Draw(img)
    draw_glyph(draw, size * SS, orbit=0.255, dot=0.055, line=0.016)
    return img.resize((size, size), Image.LANCZOS)

def foreground(size):
    # 108dp-слой: прозрачный, глиф в safe zone 66/108 = 0.61
    img = Image.new("RGBA", (size * SS, size * SS), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw_glyph(draw, size * SS, orbit=0.205, dot=0.048, line=0.019)
    return img.resize((size, size), Image.LANCZOS)

LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
FG = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}

def main(res_dir, preview=None):
    for dpi, px in LEGACY.items():
        d = os.path.join(res_dir, f"mipmap-{dpi}")
        os.makedirs(d, exist_ok=True)
        legacy(px).save(os.path.join(d, "ic_launcher.png"))
        legacy(px).save(os.path.join(d, "ic_launcher_round.png"))
    for dpi, px in FG.items():
        d = os.path.join(res_dir, f"mipmap-{dpi}")
        os.makedirs(d, exist_ok=True)
        foreground(px).save(os.path.join(d, "ic_launcher_foreground.png"))
    if preview:
        os.makedirs(os.path.dirname(preview), exist_ok=True)
        sheet = Image.new("RGBA", (560, 300), (12, 17, 28, 255))
        big = legacy(192)
        sheet.alpha_composite(big, (24, 54))
        # как выглядит круглый adaptive: фон + foreground
        for i, px in enumerate((96, 72, 48)):
            x = 250 + i * 100
            bg = Image.new("RGBA", (px, px), (11, 18, 32, 255))
            img = Image.alpha_composite(bg, foreground(px))
            mask = Image.new("L", (px, px), 0)
            ImageDraw.Draw(mask).ellipse([0, 0, px - 1, px - 1], fill=255)
            sheet.paste(img, (x, 120 - px // 2), mask)
        sheet.save(preview)
    print("icons written to", res_dir)

if __name__ == "__main__":
    res = sys.argv[1] if len(sys.argv) > 1 else "app/src/main/res"
    preview = sys.argv[2] if len(sys.argv) > 2 else None
    main(res, preview)
