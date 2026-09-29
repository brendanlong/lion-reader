# Native App Plan (Android first)

Plan for a cross-platform native Lion Reader client: Android first, iOS next,
desktop possibly later. Goals: offline reading with delta sync and bounded
storage, an offline outbox for read/starred state, share targets for URLs and
files, and narration (system voices, Piper, cloud Kokoro) that keeps playing in
the background. Delete this file once the app has its own `CLAUDE.md`.

## Decisions

### Kotlin Multiplatform core, native UI per platform

- **Shared (KMP, `commonMain`)**: API client, local database, sync engine,
  outbox, retention/eviction, settings, narration orchestration (what to say
  next, chunking, cache, which engine), and presenters/view-models exposing
  `StateFlow`s.
- **Per platform**: UI only, plus the platform services the OS forces to be
  native (share entry points, media session/background audio, TTS engines,
  background scheduling).
  - Android: Jetpack Compose + Material 3.
  - iOS (later): SwiftUI over the shared presenters (SKIE for Flow/suspend
    interop). "Look native" is the goal, and Compose Multiplatform on iOS draws
    its own widgets. The cost is writing views twice, but views are the thin
    part if presenters own the logic. Revisit when iOS starts.
  - Desktop (maybe): Compose Desktop reusing the Android views. There is no
    "native" Linux toolkit worth targeting.
- **Article body is a WebView on every platform.** Sanitized entry HTML can
  contain MathML, inline SVG, tables, `<details>`, footnotes and sandboxed
  embeds; no native text renderer handles that. Everything around the body is
  native.

### API: make `/api/v1` (OpenAPI) the official app API

- **Not the Google Reader API**: edits carry no timestamp (last arrival wins, so
  a replayed outbox clobbers newer changes), integer ids, one content variant,
  and nothing for narration, saves-with-upload or sync events.
- **Not raw tRPC**: the wire format uses the superjson transformer and tRPC's
  envelope, neither of which is a contract we want a Kotlin client pinned to.
- **`/api/v1`** already exists (trpc-to-openapi over the same procedures), is
  plain JSON, and publishes a spec at `/api/openapi`. New app endpoints are
  ordinary tRPC procedures with `.meta({ openapi })`, calling the same services
  the web uses, so there is still one implementation.
- **Compatibility**: installed apps lag the server by months. Commit the
  generated OpenAPI spec and have CI fail on breaking changes (e.g. `oasdiff
breaking`); additive changes only, new behaviour behind new fields or paths.

### Auth: OAuth 2.1 + PKCE via the browser

The OAuth server already supports public clients, PKCE and rotating refresh
tokens. Signing in through a Custom Tab gets every login method (password,
Google, Apple, passkeys) for free and keeps passwords out of the app.

Server work:

- Register a first-party client with an `https://lionreader.com/...` redirect
  verified as an Android App Link (and later an iOS Universal Link). Custom
  schemes stay rejected.
- A new scope (e.g. `reader:app`) covering reading, state, subscriptions, tags,
  saves, narration and sync, but not account-destructive actions (delete
  account, change password, manage tokens/OAuth grants). Those open the web
  settings in a Custom Tab.
- Accept OAuth access tokens for that scope in `createContext` and the SSE
  route, and opt the needed procedures in. OAuth tokens are currently
  audience-bound to `/api/mcp` and Wallabag, so this is a security-reviewed
  change (`SECURITY.md`, `src/server/oauth/CLAUDE.md`).

### Sync: bootstrap + deltas over a bounded window

The existing `sync.events` (keyset cursors, `hasMore`, typed events) is the
right shape. The app needs it over `/api/v1`, plus:

- **Bootstrap** by paging the retention window (keyset, same cursor format), so
  a fresh install or a client whose cursor is too old doesn't need a separate
  code path from `entries.list`.
- **Server-returned next cursor** instead of the client deriving it from event
  `updatedAt`/`entryId` (easy to get subtly wrong; microsecond precision).
- **Tombstones** (`entry_deleted`) for hard-deleted saved articles, which today
  just vanish.
- **Cursor too old → `resync_required`** so the client drops its window and
  re-bootstraps.
- **Batch content fetch** (`entries.getMany`: ids in; sanitized content
  variants and narration paragraphs out, see below). The service `getEntries`
  already exists for the compat APIs.

Client:

- Local DB: SQLDelight (SQL-first, mature on Android/iOS/JVM).
- Retention policy (user-adjustable, sensible defaults): metadata for all
  unread entries in the last N days (default 30) capped at a count; starred and
  saved always kept; bodies downloaded for recent unread + starred + saved up
  to a byte budget; read entries evicted LRU after a grace period; image
  caching capped separately (Coil disk cache), with an opt-in "download images
  for offline".
- Unread counts: server absolute counts (as on web), adjusted locally by
  pending outbox ops while offline.
- Live updates: SSE while foregrounded; WorkManager periodic sync in the
  background (optionally only on unmetered/charging for body downloads).

### Outbox: coalesced, timestamped, never blocked by one bad item

- One row per `(entryId, field)`; a new op replaces the old one (latest intent
  wins locally). `markAllRead` is stored as its own op with `before` and
  `changedAt`, which the endpoint already accepts, so it can't mark entries
  that arrived after the user tapped.
- Every op carries `changedAt`; `markRead` and `setStarred` already apply
  last-write-wins on it and return the winning state, which the client writes
  back.
- Clock skew: estimate server offset from response `Date` headers and adjust
  `changedAt`. Server side, clamp `changedAt` to `now()` so a fast device clock
  can't win forever.
- Batch flush (`markRead` takes up to 1000). Add a batch star endpoint (the
  service `updateEntriesStarred` exists but isn't exposed).
- Failure handling: network/5xx → backoff and retry; 4xx (entry gone) → drop
  the op and log. A single poison item must never stall the queue (the
  Wallabag Android app's failure mode, see
  `~/wiki/pages/wallabag-android-queue-http-handling.md`).
- Saves and uploads go through the same outbox, each with a client-generated
  idempotency key so a retry after a lost response doesn't double-save.

### Share targets

- Android: intent filters for `ACTION_SEND` with `text/plain` (extract the
  URL), `text/markdown`, `text/html`, `text/plain` files and `.docx`, i.e. the
  same types as `src/app/manifest.ts`. A translucent activity shows a native
  "Saved" confirmation and finishes; offline, it enqueues and says "will save
  when online".
- Uses `saved.save` / `saved.uploadFile`. Upload should accept multipart/raw
  bytes as well as base64 JSON, since files can be large.
- iOS later: a Share Extension writing into the shared outbox via an App Group.

### Narration

**The server stays the single source of the paragraph numbering.** The
element walk (`src/lib/narration/runs.ts`) and browser-equivalent parsing
(parse5 → linkedom, #1453) are the hardest thing to port and the easiest to
let drift, so the app never re-derives them:

- Content responses include narration paragraphs as structured data
  (`[{ text, o }]`) instead of a `\n\n`-joined string, and the HTML with
  `data-para-id` already stamped. The WebView only maps `o` → element for
  highlighting and tap-to-seek. The web client can adopt the same stamped HTML.
- Paragraphs for the plain (non-LLM) path are computed by the existing fallback
  builder and cached by content hash in `narration_content`, so they can be
  downloaded with bodies and narration works fully offline for system and Piper
  voices. LLM-normalized text is fetched on demand when online.

**One playback path**: Media3 `MediaSessionService` + ExoPlayer for every
engine. That gives lock screen/notification controls, Bluetooth buttons, audio
focus and background playback without the web's silent-audio and MSE
workarounds.

- System voices: Android `TextToSpeech.synthesizeToFile` per chunk, played
  through ExoPlayer like the others (rather than `speak()`, which bypasses the
  media session).
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

### Reader appearance

- Same options as web: font (system, Merriweather, Literata, Inter, Source
  Sans; bundled, all OFL), text size, justification, theme (light/dark/e-paper/
  system), list density. Per-device settings, like the web's localStorage.
- Single source: generate a JSON of appearance tokens (per-font size multiplier
  and line height, palettes) from `src/lib/appearance/config.ts` and a
  standalone `reader-prose` stylesheet from the web build; the app build copies
  both, so the WebView body looks like the web's.
- Native chrome uses Material 3 with the amber accent (optionally dynamic
  color), 44dp+ touch targets, and an e-paper theme following the
  border-over-fill rule in `src/components/CLAUDE.md`.
- App scope: reading, state, saving, narration, subscribe/unsubscribe/tags.
  Rarely used settings (account, sessions, tokens, integrations, AI keys,
  imports) open the web in a Custom Tab rather than being rebuilt.

## Repository layout

In this repo, so a change to an endpoint and its client lands in one PR:

```
kmp/
  shared/        # commonMain + androidMain/iosMain/jvmMain
  androidApp/
  iosApp/        # later
```

CI path filters so Kotlin jobs run only when `kmp/`, the OpenAPI spec or the
generated tokens/CSS change. Add `kmp/` to `.dockerignore` and knip's ignores. Release tags `android-vX.Y.Z`.

## Testing

- **Shared core on the JVM target** (fast, no emulator): sync engine, outbox
  coalescing/replay, retention, narration chunking and cache, with an in-memory
  SQLDelight driver.
- **Shared core against a real server**: a JVM test suite that starts the app
  with `pnpm services` + the dev server (as e2e does) and exercises
  bootstrap → offline edits → reconnect → conflict resolution against real
  Postgres. This catches contract drift that mocks wouldn't.
- **OpenAPI breaking-change check** in the web CI.
- **Android UI**: Compose tests under Robolectric on the JVM for most screens;
  an emulator job (GitHub Actions with KVM) for smoke tests of share intents,
  WebView highlighting and the media session.
- **Real devices**: the spare phones plugged into the dev server, reachable via
  `adb` so agent sessions can run `connectedAndroidTest` and take screenshots.
  Background narration (screen off, Bluetooth, calls/audio focus, Doze) gets a
  short manual checklist per release, since emulators don't reproduce OEM
  battery killers.

## Phases

1. **Server groundwork** (TypeScript, testable with existing suites): app OAuth
   scope + App Link redirect, token access for sync/SSE/narration, sync over
   `/api/v1` with bootstrap/tombstones/next cursor/resync, `entries.getMany`,
   batch star, `changedAt` clamp, structured narration paragraphs + stamped
   HTML, binary synthesize, upload idempotency, OpenAPI snapshot + CI check,
   appearance token/CSS export.
2. **KMP skeleton + shared core**: Gradle setup, CI, generated or hand-written
   Ktor client, SQLDelight schema, sync, outbox, retention, JVM + real-server
   tests.
3. **Android MVP**: OAuth login, lists (all, unread, starred, saved,
   recently read, subscriptions, tags), entry view, read/star with swipe, offline
   indicator, background sync, appearance settings.
4. **Share target** + offline save queue + file uploads.
5. **Narration**: ExoPlayer/MediaSession with system and cloud voices, then
   Piper via sherpa-onnx.
6. **Release**: Play Console closed testing (new personal developer accounts
   need a closed test with testers for 14 days before production) and signed
   APKs on GitHub Releases.
7. **Later**: iOS (SwiftUI, Share Extension, AVAudioSession; macOS CI runners +
   TestFlight with existing iOS users as testers), then maybe desktop.

## Open questions

- iOS UI toolkit (SwiftUI vs Compose Multiplatform), decided when iOS starts.
- Default retention numbers (days, entry count, byte budget).
- Whether appearance and narration settings should sync across devices via the
  server (web keeps them per device today).
- Play Store, or APK/F-Droid only at first.
