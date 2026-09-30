"""Generates the Android launcher icon's layers from the logo.

Renders the logo into the adaptive icon's foreground (sized so all of it stays
inside the 66dp safe zone every launcher mask keeps) and a monochrome layer for
themed icons: the logo's two outline colors as line art, since a silhouette of
the whole logo is just a blob. The background is the web's maskable blue
(`ic_launcher_background` in values/colors.xml).

Render the logo first; ImageMagick's built-in SVG renderer gets its shapes
wrong, so use librsvg (or anything built on it, like sharp). From kmp/:

    rsvg-convert -w 1024 -h 1024 ../assets/logo-original.svg -o logo.png
    uv run --no-project --with pillow python scripts/app-icon.py logo.png
"""
import math, sys
from PIL import Image

RES = "androidApp/src/main/res"
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
CANVAS_DP = 108
SAFE_RADIUS_DP = 33
OUTLINES = [(232, 72, 0), (8, 88, 128)]


def trimmed(image):
    return image.crop(image.getchannel("A").point(lambda a: 255 if a > 8 else 0).getbbox())


def safe_scale(logo):
    """dp per logo pixel that puts the farthest opaque pixel on the safe-zone circle."""
    alpha = logo.getchannel("A").load()
    cx, cy = logo.width / 2, logo.height / 2
    radius = max(
        math.hypot(x - cx, y - cy)
        for y in range(logo.height)
        for x in range(logo.width)
        if alpha[x, y] > 8
    )
    return SAFE_RADIUS_DP / radius


def outline_art(logo):
    """The outline strokes only, in black (the system tints the monochrome layer)."""
    art = Image.new("RGBA", logo.size, (0, 0, 0, 0))
    src, dst = logo.load(), art.load()
    for y in range(logo.height):
        for x in range(logo.width):
            r, g, b, a = src[x, y]
            if a == 0:
                continue
            distance = min(math.dist((r, g, b), color) for color in OUTLINES)
            # Anti-aliased edges fade out; the shading colors stay out.
            weight = max(0.0, min(1.0, (45 - distance) / 20))
            if weight > 0:
                dst[x, y] = (0, 0, 0, round(a * weight))
    return art


def write_layer(layer, dp_per_px, name):
    for density, factor in DENSITIES.items():
        size = round(CANVAS_DP * factor)
        scale = dp_per_px * factor
        scaled = layer.resize(
            (round(layer.width * scale), round(layer.height * scale)), Image.LANCZOS
        )
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        canvas.alpha_composite(
            scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2)
        )
        canvas.save(f"{RES}/mipmap-{density}/{name}.webp", lossless=True)


logo = trimmed(Image.open(sys.argv[1]).convert("RGBA"))
dp_per_px = safe_scale(logo)
write_layer(logo, dp_per_px, "ic_launcher_foreground")
write_layer(outline_art(logo), dp_per_px, "ic_launcher_monochrome")
