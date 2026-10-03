"""Generates the Android launcher icon's layers from the logo.

Renders the logo into the adaptive icon's foreground (sized so all of it stays
inside the 66dp safe zone every launcher mask keeps) and a monochrome layer for
themed icons: the logo's two outline colors as line art, since a silhouette of
the whole logo is just a blob. The background is the web's maskable blue
(`ic_launcher_background` in values/colors.xml). E-ink screens show that blue
as muddy grays, so there's also an e-ink foreground for a white background
(`ic_launcher_eink.xml`): a black book with a white spine and pages, and the
lion in gray with white ears and mane highlights.

Render the logo first; ImageMagick's built-in SVG renderer gets its shapes
wrong, so use librsvg (or anything built on it, like sharp). From kmp/:

    rsvg-convert -w 1024 -h 1024 ../public/logo.svg -o logo.png
    (or: uv run --no-project --with cairosvg python -c "import cairosvg;
    cairosvg.svg2png(url='../public/logo.svg', write_to='logo.png',
    output_width=1024, output_height=1024)")
    uv run --no-project --with pillow python scripts/app-icon.py logo.png
"""
import math, sys
from PIL import Image

RES = "androidApp/src/main/res"
DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
CANVAS_DP = 108
SAFE_RADIUS_DP = 33
OUTLINES = [(232, 72, 0), (8, 88, 128)]

BLACK, GRAY, WHITE = 0, 170, 255
# The logo's colors by part, and the e-ink tone of each.
PARTS = {
    "outline": ([(237, 79, 6), (8, 89, 135)], BLACK),
    "lion": ([(249, 186, 26), (247, 138, 16)], GRAY),
    "highlight": ([(250, 240, 195)], WHITE),
    "book": ([(58, 156, 198), (119, 209, 234), (74, 174, 119), (150, 220, 128), (32, 132, 129)], BLACK),
}
PALETTE = [(color, part) for part, (colors, _) in PARTS.items() for color in colors]


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


def regions(parts, part):
    """The connected areas of one part, as lists of pixels."""
    seen, found = set(), []
    for start, kind in parts.items():
        if kind != part or start in seen:
            continue
        seen.add(start)
        stack, area = [start], []
        while stack:
            x, y = stack.pop()
            area.append((x, y))
            for near in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
                if near not in seen and parts.get(near) == part:
                    seen.add(near)
                    stack.append(near)
        found.append(area)
    return found


def eink_art(logo):
    """The logo in black, white and one gray, each part by its nearest logo color."""
    src = logo.load()
    parts = {}
    for y in range(logo.height):
        for x in range(logo.width):
            r, g, b, a = src[x, y]
            if a > 8:
                parts[x, y] = min(PALETTE, key=lambda entry: math.dist(entry[0], (r, g, b)))[1]
    tone = {part: shade for part, (_, shade) in PARTS.items()}
    shades = {}
    # The spine is the book's one narrow area between the covers.
    for area in regions(parts, "book"):
        xs = [x for x, _ in area]
        if len(area) > 1000 and max(xs) - min(xs) < logo.width * 0.12:
            shades.update(dict.fromkeys(area, WHITE))
    # The tail's tip is the lowest highlight; it stays the lion's gray.
    tip = max(
        (area for area in regions(parts, "highlight") if len(area) > 1000),
        key=lambda area: sum(y for _, y in area) / len(area),
    )
    shades.update(dict.fromkeys(tip, GRAY))
    art = Image.new("RGBA", logo.size, (0, 0, 0, 0))
    dst = art.load()
    for pixel, part in parts.items():
        shade = shades.get(pixel, tone[part])
        dst[pixel] = (shade, shade, shade, src[pixel][3])
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
write_layer(eink_art(logo), dp_per_px, "ic_launcher_eink_foreground")
