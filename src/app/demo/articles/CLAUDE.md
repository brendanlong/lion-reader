# Demo Articles

- If you write a new article, ALWAYS have an Opus sub-agent explore the codebase and confirm that everything in the article is accurate
- To generate a summary, use the real summary prompt from src/server/services/summarization.ts and pass it to a Sonnet subagent. Ask the agent for a 30-50 word summary (one paragraph).
- Use the PR that implemented a feature as the article URL if possible
- Use the date the feature was implemented as the article date

## Illustrations (house style)

Demo article images use a **flat brand-vector** style that matches the Lion Reader
logo (`assets/logo-original.png`): flat solid color fills, thick confident
dark-navy outlines, **no gradients, no texture, no drop shadows**, on a clean
off-white background. This is deliberately _not_ the sketchnote style used on
brendanlong.com — Lion Reader's identity is bold and colorful, so illustrations
should read as siblings of the logo.

Locked palette (pull from the logo):

- Orange-red mane, gold-yellow face, teal-blue, leaf green, cream off-white
- Dark navy for all linework

The lion character is the mascot; the **prop changes to fit the article** (a
newspaper for narration, a plug/robot for MCP, tag labels for organization,
etc.). Keep the book reserved for the logo itself — don't feel obligated to put
one in every illustration.

Generated with the **Nano Banana** MCP tool (`generate_image`).

### Generating an image

Pass the logo as a character reference and force `mode: "generate"` so the
aspect ratio is honored (see gotcha below). Worked example that produced the
Text-to-Speech hero (`public/demo/text-to-speech.png`):

```
mode: "generate"                       # REQUIRED — see gotcha
input_image_path_1: assets/logo-original.png
aspect_ratio: "3:2"
resolution: "2k"
negative_prompt: "readable text, real words, watermark, paper texture, gradient shading, photorealism, 3d render, drop shadows, square crop, portrait"
prompt: >
  A clean, polished flat-vector illustration in the exact brand style of the
  reference Lion Reader logo: flat solid color fills, thick confident dark-navy
  outlines, no gradients, no texture. Brand palette only: orange-red,
  gold-yellow, teal-blue, leaf green, cream off-white, dark navy linework.
  Composition: the Lion Reader lion (spiky orange mane, gold face, from the
  reference) {DESCRIBE THE SCENE AND PROP}. Wide horizontal landscape banner
  composition, subject centered with lots of empty off-white space on the left
  and right. Solid off-white background, cheerful and modern. No real text, no
  readable letters, no words.
```

Tips (learned the hard way):

- **Force `mode: "generate"`.** Passing an input image auto-selects _edit_ mode,
  which treats the logo as a canvas and inherits its **square** shape, silently
  ignoring `aspect_ratio`. `mode: "generate"` uses the logo as a style/character
  reference instead and honors 3:2. Also add "wide horizontal landscape banner"
  to the prompt as belt-and-suspenders.
- **Always pass the logo** as `input_image_path_1` so the lion stays on-model
  across articles.
- **State what you want, don't negate.** Spell out the palette and "flat solid
  fills, thick navy outlines"; reserve `negative_prompt` for stray artifacts.
- **Say "off-white background", not "paper"** — "paper" adds visible fiber texture.
- **No text in images.** The article title already sits above the image; asking
  for banner/label text just produces garbled letters.
- Nano Banana writes a `<name>_thumb.jpeg` next to the output — delete it, and
  clean up rejected drafts.
- The user reviews over the web UI. To share candidates, serve the image dir over
  HTTP on a random port (`python3 -m http.server <port> --bind 0.0.0.0`) and give
  them `http://brendan-desktop.tail8de88a.ts.net:<port>/`.

### Optimizing

Nano Banana PNGs are ~1.5 MB at 2k. For these flat illustrations, resize +
palette-quantize is visually lossless and cuts ~90%. We ship a **single
optimized PNG** — the avif/webp `<picture>` multi-format dance is overkill for a
handful of demo images.

```bash
magick <raw>.png -resize 1440x -strip -colors 128 -define png:compression-level=9 out.png
optipng -quiet -o5 out.png    # ~1.6 MB -> ~135 KB
```

- **1440px wide** is retina-friendly for the reading column; don't ship the 2528px raw.
- **128 colors** is the sweet spot for this flat art (no banding on the outlines).
  Eyeball 64 vs 128 if you want it smaller; drop to 128 if 64 bands.
- Put the final file in `public/demo/<article-id>.png`.

### Embedding in an article

Add a hero `<figure>` at the top of the article's `contentHtml`. The reader
applies `rounded-lg` + `shadow-md` to images automatically (via `reader-prose`
in `EntryContentRenderer`), so no inline styling is needed — just alt text:

```html
<figure>
  <img src="/demo/text-to-speech.png" alt="Descriptive alt text of the scene." />
</figure>
```
