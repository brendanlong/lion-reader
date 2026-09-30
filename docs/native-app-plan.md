# Native App Plan

What's left of the plan for the native Lion Reader client (Kotlin
Multiplatform, Android first). The app as built — architecture, API, auth,
sync, outbox, retention, reader view — is documented in `kmp/CLAUDE.md`.
Each phase below adds the server pieces it needs alongside its client code.

## Remaining phases

1. **Share target**: saving URLs and files from other apps, offline included.
2. **Narration**: system, Piper and cloud voices with background playback.
3. **Release**: Play Console closed testing (new personal developer accounts
   need a closed test with testers for 14 days before production) and signed
   APKs on GitHub Releases. Set `ANDROID_APP_CERT_SHA256` on the server to the
   release key's fingerprint so the sign-in App Link verifies.
4. **Later**: iOS (SwiftUI over the shared core, a Share Extension,
   AVAudioSession; macOS CI runners + TestFlight with existing iOS users as
   testers), then maybe desktop.

## Decisions for those phases

### Share targets

- Android: intent filters for `ACTION_SEND` with `text/plain` (extract the
  URL), `text/markdown`, `text/html`, `text/plain` files and `.docx`, i.e. the
  same types as `src/app/manifest.ts`. A translucent activity shows a native
  "Saved" confirmation and finishes; offline, it enqueues and says "will save
  when online".
- Uses `saved.save` / `saved.uploadFile` (base64 JSON, capped at
  `maxSavedArticleSizeBytes`; a raw-bytes variant is nice to have, not
  required).
- iOS later: a Share Extension writing into the shared outbox via an App Group.

- Server: app-token access to `saved.*`, and an idempotency key for uploads
  so a retried upload doesn't save twice (`saved.save` already returns the
  existing article for a known URL).

### Narration

**The server stays the single source of the paragraph numbering.** The
element walk (`src/lib/narration/runs.ts`) and browser-equivalent parsing
(parse5 → linkedom, #1453) are the hardest thing to port and the easiest to
let drift, so the app never re-derives them:

- Content responses include narration paragraphs as structured data
  (`[{ text, o }]`) instead of a `\n\n`-joined string, and the HTML with
  `data-para-id` already stamped (after sanitizing, per content variant). The
  WebView only maps `o` → element for highlighting and tap-to-seek. The web
  client can adopt the same stamped HTML.
- Plain (non-LLM) paragraphs are built by the existing fallback builder. Today
  that runs uncached on every call (web builds plain narration in the browser,
  and `narration_content` caches only LLM output), so `entries.getMany` needs
  a cache keyed by the `NARRATION_FORMAT_VERSION` content hash to keep the
  parse5 + linkedom pass off the hot path. Downloaded with bodies, they make
  system and Piper narration fully offline.
- LLM-normalized text is fetched on demand, with opt-in prefetch for starred
  and saved entries; offline it falls back to plain paragraphs.

**One playback path**: Media3 `MediaSessionService` + ExoPlayer for every
engine. That gives lock screen/notification controls, Bluetooth buttons, audio
focus and background playback without the web's silent-audio and MSE
workarounds.

- System voices: Android `TextToSpeech.synthesizeToFile` per chunk, played
  through ExoPlayer like the others (rather than `speak()`, which bypasses the
  media session). Some OEM engines and network voices handle it badly, so keep
  a `speak()` fallback and test on the spare phones.
- Piper: sherpa-onnx (Kotlin on Android, Swift/C on iOS) with its converted
  Piper models, which bundle espeak-ng data. Host the model bundles ourselves;
  keep the web's voice ids so settings mean the same thing everywhere.
- Cloud (Kokoro via `narration.synthesize`): prefetch by listening time as the
  web does, cache MP3 chunks on disk keyed by `(model, voice, textHash)` with a
  small LRU cap. No offline guarantee. Add a binary response variant (bytes,
  not base64 JSON) and token auth.
- Engine chunking (sentence for Piper, ≤1000 chars for cloud) lives in shared
  Kotlin; highlight granularity stays per paragraph, so sentence splitting
  doesn't need to match the web's exactly.
- Server: token access for narration, structured paragraphs + stamped HTML +
  the plain-paragraph cache above, and a binary synthesize response.

## Open questions

- iOS UI toolkit (SwiftUI vs Compose Multiplatform), decided when iOS starts.
- Whether appearance and narration settings should sync across devices via the
  server (web keeps them per device today).
- Play Store, or APK/F-Droid only at first.
