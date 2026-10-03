# Native App Plan

What's left of the plan for the native Lion Reader client (Kotlin
Multiplatform, Android first). The app as built is documented in
`kmp/CLAUDE.md` (overview and rules) and in the KDoc of the classes doing the
work. Each phase below adds the server pieces it needs alongside its client code.

## Remaining phases

1. **Share target, files**: saving shared files from other apps (links are
   done).
2. **Narration**: AI-normalized text (device and cloud voices are done). Piper voices wait on sherpa-onnx 2.0,
   which drops espeak-ng (GPL-3.0, compiled into today's library), and on
   licensing: of the web's four voices only `en_GB-alba-medium` (CC BY 4.0) is
   clear for any use. The runtime also adds about 24 MB per ABI.
3. **Release**: the Play Console listing and its 14-day closed test (new
   personal developer accounts need one before production); signed builds on
   `android-v*` tags are set up (see `docs/DEPLOYMENT.md`).
4. **Later**: iOS (SwiftUI over the shared core, a Share Extension,
   AVAudioSession; macOS CI runners + TestFlight with existing iOS users as
   testers), then maybe desktop.

## Decisions for those phases

### iOS

The shared core (`:shared`) already compiles for iOS. The app supplies what
Android's `AppGraph` does: `Accounts` with a Keychain-backed `KeyValueStore`
(tokens included), an `AccountStorage` over SQLDelight's native driver, and a
`BackgroundSync` on BGTaskScheduler running `runBackgroundSync`; a WKWebView
serving the reader assets at its own origin for `readerDocument`; and a
narrator over the platform's player, making the decisions in
`NarrationRules.kt` and fetching cloud voices with `streamCloudSpeech`. The reader assets (scripts, fonts,
`appearance.json`) are bundled from `kmp/androidApp/src/main/assets/reader/`.

### Share targets

- Android files: add `ACTION_SEND` filters for `text/markdown`, `text/html`,
  `text/plain` files and `.docx` (the same types as `src/app/manifest.ts`) to
  the link share target, uploading through `saved.uploadFile` (base64 JSON,
  capped at `maxSavedArticleSizeBytes`).
- iOS later: a Share Extension writing into the shared outbox via an App Group.
- Server: app-token access to `saved.uploadFile`, and an idempotency key for
  uploads so a retried upload doesn't save twice.

### Narration

How narration works in the app is in `Narrator`'s and `SpeechEngine`'s KDoc;
what's left:

- **Piper voices**: a `SpeechEngine` over sherpa-onnx (its static-link AAR,
  from JitPack) and its converted Piper models from the `tts-models` release
  (int8, about 21 MB a voice, plus espeak-ng data shared by all), downloaded on
  demand. Keep the web's voice ids so settings mean the same thing everywhere,
  though sherpa-onnx's builds aren't the web's model files.
- **AI-normalized text** (`narration.generate`): token access, fetched on
  demand; offline it falls back to the reader's own paragraphs. Its paragraph
  map indexes the same elements, so highlighting is unchanged.

## Open questions

- iOS UI toolkit (SwiftUI vs Compose Multiplatform), decided when iOS starts.
- Whether appearance and narration settings should sync across devices via the
  server (web keeps them per device today).
- Play Store, or APK/F-Droid only at first.
