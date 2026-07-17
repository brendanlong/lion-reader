# Feed-parser boundary benchmarks

Harness for measuring the N-API boundary cost of the native feed parser
(built for issue #1291's external-string experiment; kept because it's the
tool for evaluating any future boundary change).

```bash
pnpm build:native   # or: node native/feed-parser/build.mjs

# End-to-end sync / async / main-thread-stall timings, plus optional
# canonical JSON output for parity diffs across builds:
node native/feed-parser/bench/bench.mjs --json /tmp/parity --iters 20 <feeds...>

# GC stress: 8x concurrent parses, checksums across forced GC (catches the
# use-after-free class if strings ever wrap native-owned memory again):
node --expose-gc native/feed-parser/bench/stress-gc.mjs <feeds...>
```

Corpus used for #1286/#1291 (fetch fresh; not committed):

- https://xkcd.com/atom.xml (~3 KB)
- https://www.youtube.com/feeds/videos.xml?channel_id=UCXuqSBlHAE6Xw-yeJA0Tunw (~37 KB)
- https://wordpress.org/news/feed/ (~200 KB)
- https://blog.rust-lang.org/feed.xml (~380 KB)
- https://www.lesswrong.com/feed.xml?view=curated-rss (~250 KB, CDATA HTML bodies)
- https://danluu.com/atom.xml (~10 MB — the content-heavy worst case)

## Result of the external-string experiment (#1291, dropped)

`node_api_create_external_string_latin1` (zero-copy, Node 20.4+, requires
pure-ASCII data) was implemented behind a 16 KB threshold with dlsym runtime
detection — see the reverted commit referenced from issue #1291. Verdict:

- **Real feeds are almost never pure ASCII.** One curly quote or em-dash
  anywhere disqualifies a string; across the corpus, 0% of large-body bytes
  were eligible except danluu's at 6%. danluu end-to-end was unchanged.
- **Even at 100% eligibility the win was only ~1.2×** (17 MB synthetic
  pure-ASCII feed: 24.3 → 19.8 ms sync). For ASCII input,
  `napi_create_string_utf8` already produces a V8 one-byte string with a
  near-memcpy copy; the expensive conversion is non-ASCII UTF-8 → UTF-16
  transcoding, exactly what a Latin-1 external string can't cover. A UTF-16
  external arm would still pay one transcode copy plus 2× resident memory.
- Mechanics all worked: V8 accepted every external string on stock Node 22
  (`copied` out-param never set — the V8 sandbox is off in official builds),
  checksums were stable across forced GC, and memory was reclaimed after the
  (deferred, next-tick) N-API finalizers ran.
