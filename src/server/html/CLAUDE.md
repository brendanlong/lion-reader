# HTML Sanitization (`src/server/html/`)

**Security-critical**: the sanitizer is the primary XSS defense for entry bodies and AI summaries, which render via `dangerouslySetInnerHTML` (SECURITY.md §1). The pipeline is the native crate `native/sanitizer/` (stages listed in `core/src/lib.rs`), wrapped by `sanitize.ts`; `sanitize-entry.ts` is the read-path entry point.

## Where sanitization happens

- **On every read, in the services layer.** Entries store only raw content (`entries.content_*` / `full_content_*`); `toFullEntry`/`getEntry`/`getEntries` (`services/entries.ts`), the saved-article reads (`saved.ts`), `full-content.ts` and `summarization.ts` funnel through `sanitizeEntryContentFamily` or `sanitizeEntryHtml[Async]`. Fetch, WebSub and email ingest store raw and sanitize nothing.
- **Never add a client-side sanitizer, and never persist sanitized output** — except AI summaries, which are stored sanitized and still re-sanitized on read.
- There is deliberately **no sanitizer version constant**: a rules change takes effect on the next read after a deploy. Don't reintroduce one without a consumer that compares it.
- The full-content family sanitizes the whole-page `original` only when `cleaned` is NULL, because only `cleaned ?? original` is ever shown; the content family sanitizes both (the UI toggles between them).
- Request paths use the async forms (libuv thread pool above ~10 KB; `getEntries` bounds its concurrency); background jobs use the sync forms. Readability (`cleanContent[Async]`) and Markdown follow the same split.

## Rules for the native crate

Every allow-list or transform change needs a security review, and the property tests named below are the bar — examples are what missed past bypasses.

- **Any new rawtext/RCDATA element (`title`/`xmp`/`noscript`/…) goes in `DROP_WITH_CONTENT`, never the unwrap path**: unwrapping re-emits its contents as live markup (mXSS).
- **What the pass keeps must tokenize the same regardless of what it deleted around it or which namespace it thinks it's in**, and output never ends mid-tag (API clients append their own markup). `handle_text` explains the bypasses; `output_parses_to_allow_listed_markup_only` / `pipeline_output_parses_to_allow_listed_markup_only` are the tests.
- **`drop_disallowed_end_tags` is the sharpest edge**: deleting already-tokenized bytes stays safe only because of what it refuses to cut, and every relaxation so far was a working `<img onerror>` injection. Change its invariants only against `end_tag_drop_never_adds_markup`.
- **Never soften a native guard to avoid a throw.** The allow-list pass has no partial output, so its failure throws; `sanitize.ts` returns `null` (no body) and logs length + SHA-256, never the body. lol_html's text-content-tag-inside-`<select>` error is the `<select><xmp><script>` mXSS gadget — `strict: false` would trade a blank entry for a bypass.
- **Any recursive walk over parsed content goes behind the `MAX_DOM_DEPTH` check** (`core/src/depth.rs`), which must stay iterative: a stack overflow kills the process on every read of that entry and `catch_unwind` can't catch it.
- **Id namespacing** (`core/src/idrefs.rs`, #1425): an id may be renamed only if every reference to it is renamed in the same pass, so adding an id-referencing attribute to any allow-list means adding it to `idrefs.rs`. When writing a value back, match that pass's own escaping (raw for lol_html, decoded for the SVG pass), or the rewrite stops being idempotent.
- **Iframe embeds** (`core/src/embeds.rs`) are the only copy of the provider rules (#1541); TS code that synthesizes an embed reads them through the exported `normalizeEmbed` (see `youtube-embed.ts`).
- A start tag whose attribute the pass rewrites (an `id`, a `#fragment` href) is re-serialized; everything else passes through byte-identical, so don't assert byte-identity on markup carrying one.

Tests: `pnpm test:native` for the crate; TS pipeline tests in `tests/unit/` (`sanitize-entry-html`, `mathjax-chtml`, `sanitize-svg`, `embed-providers`). Benchmark: `scripts/bench-sanitize.mts`.
