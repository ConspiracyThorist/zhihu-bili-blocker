"""生成扩展图标：深底 + 粉色禁止符。运行：python scripts/make-icons.py"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "assets" / "icons"
OUT.mkdir(parents=True, exist_ok=True)

SCALE = 8
SIZES = [16, 32, 48, 128]

BG = (22, 24, 29, 255)
RING = (251, 114, 153, 255)
LEGEND = (232, 234, 237, 255)


def draw_icon(size: int) -> Image.Image:
    canvas = size * SCALE
    img = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    pad = canvas * 0.045
    radius = canvas * 0.22
    d.rounded_rectangle([pad, pad, canvas - pad, canvas - pad], radius=radius, fill=BG)

    cx = cy = canvas / 2
    r = canvas * 0.28
    ring_w = max(1, int(canvas * 0.085))

    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=RING, width=ring_w)

    # 斜杠：45 度，压在圆环上
    import math

    ang = math.radians(-45)
    dx, dy = math.cos(ang) * r * 0.92, math.sin(ang) * r * 0.92
    d.line([cx - dx, cy - dy, cx + dx, cy + dy], fill=RING, width=ring_w)

    # 右下角一个小圆点，避免整体过于单薄
    dot = canvas * 0.055
    d.ellipse(
        [canvas - pad - dot * 3.4, canvas - pad - dot * 3.4, canvas - pad - dot * 1.2, canvas - pad - dot * 1.2],
        fill=LEGEND,
    )

    return img.resize((size, size), Image.LANCZOS)


for s in SIZES:
    path = OUT / f"icon{s}.png"
    draw_icon(s).save(path)
    print(f"wrote {path}")
