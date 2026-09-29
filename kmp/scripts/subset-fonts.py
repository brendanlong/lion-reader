"""Subsets the reader's Google Fonts (OFL) for the app's assets.

Pins every variable axis but weight (kept at 300-800), keeps Latin, and writes
woff2 — about 1 MB for all eight files instead of ~15 MB.

Download each family's variable TTFs from github.com/google/fonts (ofl/<name>/)
into <dir>/<name>/, then from <dir>:

    uv run --no-project --with fonttools --with brotli python subset-fonts.py <out>

and copy <out>/*.woff2 to androidApp/src/main/assets/reader/fonts/.
"""
import glob, os, sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

# Latin + Latin-1 + Latin Extended-A + common punctuation/symbols.
UNICODES = "U+0000-024F,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+2000-206F,U+2074,U+20AC,U+2122,U+2190-2199,U+2212,U+2215"
out = sys.argv[1]
for path in sorted(glob.glob("*/*.ttf")):
    font = TTFont(path, lazy=False)
    axes = {a.axisTag: a for a in font["fvar"].axes}
    limits = {}
    for tag, axis in axes.items():
        if tag == "wght":
            lo = max(axis.minValue, 300); hi = min(axis.maxValue, 800); limits[tag] = (lo, min(max(axis.defaultValue, lo), hi), hi)
        else:
            limits[tag] = axis.defaultValue
    opts = subset.Options()
    opts.layout_features = ["*"]
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=subset.parse_unicodes(UNICODES))
    sub.subset(font)
    font = instancer.instantiateVariableFont(font, limits)
    name = os.path.basename(path).split("[")[0] + ".woff2"
    font.flavor = "woff2"
    font.save(os.path.join(out, name))
    print(name, os.path.getsize(os.path.join(out, name)))
