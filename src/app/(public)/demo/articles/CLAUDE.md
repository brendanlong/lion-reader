# Demo Articles

- If you write a new article, ALWAYS have an Opus sub-agent explore the codebase and confirm that everything in the article is accurate
- Write for users, not developers: no CSS class names, hex codes, or implementation details users don't act on. "How It Works" sections are fine, but only when the mechanism is genuinely interesting to a reader.
- Show, don't just tell, when the feature is visual — e.g. the plugins article embeds a real MathML equation to demo math rendering (demo contentHtml is emitted raw, so native MathML/iframes etc. just work).
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

Each hero **doubles as the article's social/OG preview image**, so target the OG
shape (**~1200×630, 1.91:1**). Nano Banana has no 1.91:1 preset, so generate at
its closest wide preset (**16:9**) and crop to 1200×630 in the optimize step.
Keep the subject centered with side whitespace so the crop is safe.

### Generating an image

Pass the lion as a character reference and force `mode: "generate"` so the aspect
ratio is honored (see gotcha below). For consistent, on-model lions across the
set, use the **single canonical full-body mascot** and the **`pro`** model tier:

- `input_image_path_1: assets/lion-body.png` — the canonical full-body mascot: a
  clean sitting lion with well-defined paws, legs, tail and cream chest. **Use
  exactly one reference.** This evolved through three tries: (1) the logo alone
  on `nb2` — the logo is a lion _behind a book_, so the face/body aren't visible
  and the lion drifted between images; (2) logo + `lionreader_emojis.png` sheet
  together on `pro` — two references confused the model and it still drifted;
  (3) a single clean **face** crop (`assets/lion-face.png`) on `pro` — fixed the
  face but, with no body to copy, `nb`'s invented legs/paws came out blurry and
  malformed. The fix was to first generate one clean full-body lion from the face
  crop, save it as `assets/lion-body.png`, and use **that** as the sole reference.
  It keeps proportions/paws/tail consistent _and_ still poses fine (the model
  re-poses it for e.g. the dashing `performance` hero). `assets/lion-face.png` is
  kept for regenerating the body reference itself.
- `model_tier: "pro"` — noticeably better reference adherence than the default
  `nb2` for this style-matching job.

Brand reference assets available in `assets/`: `lion-body.png` (canonical mascot,
use this), `lion-face.png` (face crop, for regenerating the body), `logo-original.png`
(the `:savetolionreader:` book-reading emoji), `saluting-lion-reader.png`
(`:salutinglionreader:`), `crying-lion-reader.png`, and `lionreader_emojis.png` (a
sheet of expression emojis).

In the prompt, say "match the lion's body, face, proportions, paws, tail and
colors precisely to the reference mascot image". Worked example that produced the
Text-to-Speech hero (`public/demo/text-to-speech.png`) used an older
single-logo/`nb2` recipe:

```
mode: "generate"                       # REQUIRED — see gotcha
input_image_path_1: assets/lion-body.png   # single canonical full-body mascot
model_tier: "pro"                      # better reference adherence than nb2
aspect_ratio: "16:9"                   # closest wide preset; cropped to 1200x630 later
resolution: "2k"
negative_prompt: "readable text, real words, watermark, paper texture, gradient shading, photorealism, 3d render, drop shadows, square crop, portrait"
prompt: >
  A clean, polished flat-vector illustration in the exact brand style of the
  reference Lion Reader logo: flat solid color fills, thick confident dark-navy
  outlines, no gradients, no texture. Brand palette only: orange-red,
  gold-yellow, teal-blue, leaf green, cream off-white, dark navy linework.
  Composition: the Lion Reader lion (spiky orange mane, gold face, from the
  reference) {DESCRIBE THE SCENE AND PROP}. Wide horizontal landscape banner
  composition, subject roughly centered with generous empty off-white space on
  both the left and right sides so it works as a wide banner. Solid off-white
  background, cheerful and modern. No real text, no readable letters, no words.
```

Tips (learned the hard way):

- **Force `mode: "generate"`.** Passing an input image auto-selects _edit_ mode,
  which treats the logo as a canvas and inherits its **square** shape, silently
  ignoring `aspect_ratio`. `mode: "generate"` uses the logo as a style/character
  reference instead and honors 3:2. Also add "wide horizontal landscape banner"
  to the prompt as belt-and-suspenders.
- **Always pass `assets/lion-body.png`** as `input_image_path_1` so the lion stays
  on-model across articles. Don't use a head-only reference (the model renders bad
  legs when it has to invent the body). The "one reference" rule is about the
  _lion_ — you _may_ add `input_image_path_2/3` for specific **props**, as long as
  the lion stays on `_1`. The `discord-bot` hero passed the logo
  (`:savetolionreader:`) and `assets/saluting-lion-reader.png`
  (`:salutinglionreader:`) as refs 2 and 3 to render those exact brand emojis;
  label each in the prompt ("image 2 is …, image 3 is …").
- **Guard against extra limbs.** The lion sometimes sprouts a third arm when it
  holds/manipulates a prop. Add "exactly two front paws — no extra arms or limbs"
  to the prompt and `extra arms, extra limbs` to `negative_prompt`.
- **Generate `n: 2` for anything non-trivial** and pick the best — cheap insurance
  against a bad pose/limb/composition. A montage contact sheet
  (`magick montage … -tile 3xN`) reviews a batch in one image.
- **Small fixes: use `mode: "edit"`** on the finished PNG instead of regenerating
  (e.g. `json-feed` had stray `<>` brackets deleted this way) — it preserves the
  rest. Edit mode auto-selects the `nb2` model and may return a different size, so
  re-run the crop to 1200×630.
- **Match the reference pose for "receiving" scenes.** When something is delivered
  _to_ the lion (conveyor, broadcast tower, phone share), say "sitting upright
  facing forward (matching the reference)" or it drifts off-model.
- **State what you want, don't negate.** Spell out the palette and "flat solid
  fills, thick navy outlines"; reserve `negative_prompt` for stray artifacts.
- **Say "off-white background", not "paper"** — "paper" adds visible fiber texture.
- **No _sentences_ in images**, but meaningful **iconography is fine and good**: an
  RSS glyph, JSON `{ }`, `</>`, file-type badges (W/Md/T), a git-branch all read
  cleanly. Give each article one **distinct, recognizable prop** and keep
  motifs from colliding across the set (e.g. `browser-extension` = a puzzle piece
  in a browser; `plugins` = several modular pieces).
- Nano Banana writes a `<name>_thumb.jpeg` next to the output — delete it, and
  clean up rejected drafts.
- The user reviews over the web UI. To share candidates, serve the image dir over
  HTTP on a random port (`python3 -m http.server <port> --bind 0.0.0.0`) and give
  them `http://brendan-desktop.tail8de88a.ts.net:<port>/`.

### Optimizing

Nano Banana PNGs are ~1.5 MB at 2k. For these flat illustrations, crop to the OG
frame + palette-quantize is visually lossless and cuts ~95%. We ship a **single
optimized PNG** — the avif/webp `<picture>` multi-format dance is overkill for a
handful of demo images.

```bash
# center-crop the 16:9 render to the 1200x630 OG frame, then quantize
magick <raw>.png -resize 1200x630^ -gravity center -extent 1200x630 \
  -strip -colors 128 -define png:compression-level=9 out.png
optipng -quiet -o5 out.png    # ~1.6 MB -> ~90 KB
```

- **1200×630** is the social/OG frame and is plenty sharp for the reading column too.
  Keep this exact size: the `og:image:width`/`height` tags are emitted from the
  `OG_IMAGE_WIDTH`/`OG_IMAGE_HEIGHT` constants in `src/lib/metadata.ts`, so a hero
  at a different size would advertise wrong dimensions to crawlers.
- **128 colors** is the sweet spot for this flat art (no banding on the outlines).
  Eyeball 64 if you want it smaller, but stay at 128 if 64 bands the outlines.
- Put the final file in `public/demo/<article-id>.png`.
- Also ship an opaque **`public/demo/<article-id>-og.png`** sibling at the same
  1200×630 size. The hero may be transparent (it renders on the reader
  background), but the social/OG card is composited by the platform onto an
  unpredictable background, so the OG variant must bake in a solid background.
  When there are no transparency concerns, `-og.png` can just be a copy of the hero.

### Wiring it into an article

Set two fields on the `DemoArticle` — **don't** hand-write a `<figure>` in
`contentHtml`. The `heroImage` field drives the in-article hero; the `og:image`
uses its `-og.png` sibling automatically (`resolveOgImage` in data.ts):

```ts
heroImage: "/demo/<article-id>.png",
heroImageAlt: "Descriptive alt text of the scene.",
// ogImage: "/demo/<article-id>-og.png"  // implicit; set only to override the -og convention
```

`getDemoEntryArticleProps` prepends the hero `<figure>` to the content (the reader
applies `rounded-lg` automatically via `reader-prose`), and each demo page's
`generateMetadata` passes `entry?.ogImage` (the resolved `-og.png`) to
`pageOpenGraph`, so the opaque variant is the social preview on whatever
`/demo/...?entry=` URL is shared.

Both the hero and OG URLs are run through `demoImageUrl` (`../demo-assets.ts`),
which serves them from the CDN with a `?v=<content-hash>` cache-buster. **After
adding or changing any `public/demo/*` image, regenerate the hash manifest:**

```bash
pnpm generate:demo-images   # updates demo-image-manifest.ts; commit it
```

`pnpm build` runs this too, and CI's `check:demo-images` fails if the committed
manifest is stale.
