# Native App Plan

What's left of the plan for the native Lion Reader client (Kotlin
Multiplatform, Android first). The app as built — architecture, API, auth,
sync, outbox, retention, reader view — is documented in `kmp/CLAUDE.md`.
Each phase below adds the server pieces it needs alongside its client code.

## Remaining phases

1. **Share target, files**: saving shared files from other apps (links are
   done).
2. **Narration**: cloud and Piper voices, AI-normalized text, and playing on
   into the next article (system voices are done).
3. **Release**: Play Console closed testing (new personal developer accounts
   need a closed test with testers for 14 days before production) and signed
   APKs on GitHub Releases. Set `ANDROID_APP_CERT_SHA256` on the server to the
   release key's fingerprint so the sign-in App Link verifies.
4. **Later**: iOS (SwiftUI over the shared core, a Share Extension,
   AVAudioSession; macOS CI runners + TestFlight with existing iOS users as
   testers), then maybe desktop.

## Decisions for those phases

### Share targets

- Android files: add `ACTION_SEND` filters for `text/markdown`, `text/html`,
  `text/plain` files and `.docx` (the same types as `src/app/manifest.ts`) to
  the link share target, uploading through `saved.uploadFile` (base64 JSON,
  capped at `maxSavedArticleSizeBytes`).
- iOS later: a Share Extension writing into the shared outbox via an App Group.
- Server: app-token access to `saved.uploadFile`, and an idempotency key for
  uploads so a retried upload doesn't save twice.

### Narration

How narration works in the app is in `kmp/CLAUDE.md`; what's left:

- **Cloud voices** (Kokoro via `narration.synthesize`, which the app's token
  can call; its response stays base64 JSON, a third bigger than raw bytes but
  without a second authenticated route to keep in step). The app prefetches by
  listening time as the web does and caches MP3 chunks on disk keyed by
  `(model, voice, textHash)` with a small LRU cap (no offline guarantee).
- **Piper voices**: sherpa-onnx with its converted Piper models, which bundle
  espeak-ng data; about 60 MB per voice, downloaded on demand. Keep the web's
  voice ids so settings mean the same thing everywhere, though sherpa-onnx's
  builds aren't the web's model files.
- **AI-normalized text** (`narration.generate`): token access, fetched on
  demand; offline it falls back to the reader's own paragraphs. Its paragraph
  map indexes the same elements, so highlighting is unchanged.

## Open questions

- iOS UI toolkit (SwiftUI vs Compose Multiplatform), decided when iOS starts.
- Whether appearance and narration settings should sync across devices via the
  server (web keeps them per device today).
- Play Store, or APK/F-Droid only at first.
