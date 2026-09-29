# Native App Plan (Android first)

Plan for a cross-platform native Lion Reader client: Android first, iOS next,
desktop possibly later. Goals: offline reading with delta sync and bounded
storage, an offline outbox for read/starred state, share targets for URLs and
files, and narration (system voices, Piper, cloud Kokoro) that keeps playing in
the background.

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
  generated OpenAPI spec and have CI fail on breaking changes (e.g. with
  oasdiff); additive changes only, new behaviour behind new fields or paths.

### Auth: OAuth 2.1 + PKCE via the browser

The OAuth server already supports public clients, PKCE and rotating refresh
tokens. Signing in through a Custom Tab gets every login method (password,
Google, Apple, passkeys) for free and keeps passwords out of the app.

Server work:

- Register a first-party client with an `https://lionreader.com/...` redirect
  verified as an Android App Link (and later an iOS Universal Link). Custom
  schemes stay rejected.
- An app scope covering reading, state, subscriptions, tags, saves, narration
  and sync, but not account-destructive actions (delete account, change
  password, manage tokens/OAuth grants); those open the web settings in a
  Custom Tab. Either reuse `reader:full-access` or add a narrower scope, but
  **grant it only to the pinned first-party `client_id`**: dynamic client
  registration lets any client request any supported scope, so an unrestricted
  scope would hand the full reader API to any registered client after one
  consent click.
- Mint those tokens with a new `/api/v1` audience, and accept only that
  audience in `createContext` and the SSE route (MCP-audience tokens stay
  rejected there). Opt in the procedures the app needs, including the ones that
  are session-only today (`sync.*`, `entries.markAllRead`, narration). This is a
  security-reviewed change (`SECURITY.md`, `src/server/oauth/CLAUDE.md`).
- Client: refresh is single-flight across processes (UI, WorkManager, share
  activity) with the new refresh token persisted before use. Rotation has only
  a short reuse-grace window, so two concurrent refreshes revoke the whole
  token family and sign the user out.

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
  and narration paragraphs out, see below). The service `getEntries` already
  exists for the compat APIs. Offline downloads fetch the variant the user
  would see (full content when the subscription has `fetchFullContent`,
  otherwise the cleaned feed content); other variants load on demand.
- **Visibility rules**, which deltas alone don't express: on
  `subscription_deleted`, drop that subscription's unstarred, unsaved entries;
  an unstar on an unsubscribed feed's entry drops it locally; on resubscribe,
  run a scoped bootstrap for that subscription (its old entries are older than
  the cursor, so deltas won't bring them back).

Client:

- Local DB: SQLDelight (SQL-first, mature on Android/iOS/JVM).
- Retention policy (user-adjustable, sensible defaults): metadata for all
  unread entries in the last N days (default 30) capped at a count; starred and
  saved always kept; bodies downloaded for recent unread + starred + saved up
  to a byte budget; read entries evicted LRU after a grace period; image
  caching capped separately (Coil disk cache), with an opt-in "download images
  for offline".
- Eviction never removes an entry with a pending outbox op or in-flight save.
- Unread counts: server absolute counts (as on web), adjusted locally by
  pending outbox ops while offline. When a flush returns absolute counts, the
  op's adjustment is removed in the same local transaction so it isn't counted
  twice. A pending `markAllRead` shows 0 for its scope.
- Live updates: SSE while foregrounded; WorkManager periodic sync in the
  background (optionally only on unmetered/charging for body downloads).

### Outbox: coalesced, timestamped, never blocked by one bad item

- One row per `(entryId, field)`; a new op replaces the old one (latest intent
  wins locally). `markAllRead` is stored as its own op with `before` and
  `changedAt`, which the endpoint already accepts. `before` is the newest
  server `fetchedAt` the client had seen, so it's in server time and unaffected
  by clock skew. It filters on `fetchedAt`, so an old entry newly visible (e.g.
  a fresh subscription) can still be caught; acceptable.
- Every op carries `changedAt`; `markRead` and `setStarred` already apply
  last-write-wins on it and return the winning state, which the client writes
  back.
- Clock skew: each flush sends `clientSentAt`; the server rebases every
  `changedAt` by `serverNow − clientSentAt`, then clamps to `now()` so a fast
  device clock can't win forever. (`Date` headers only have one-second
  resolution.)
- Batch flush (`markRead` takes up to 1000). Add a batch star endpoint; the
  `updateEntriesStarred` service takes one `changedAt` for the whole batch, so
  it needs per-entry timestamps like `markEntriesRead`.
- Failure handling: drop an op only when the item is explicitly rejected
  (missing from the per-item results, or a 400/422 validation error). 401 →
  refresh and pause; 429/5xx/network → back off and retry. Never drop the queue
  on a blanket 4xx, and never let one poison item stall it (the existing
  Wallabag Android app halts its whole queue on any non-2xx save).
- Saves and uploads go through the same outbox. `saved.save` already returns
  the existing article for a known URL; uploads need an idempotency key so a
  retry after a lost response doesn't double-save.

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

### Reader appearance

- Same options as web: font (system, Merriweather, Literata, Inter, Source
  Sans; bundled, all OFL), text size, justification, theme (light/dark/e-paper/
  system), list density. Per-device settings, like the web's localStorage.
- Single source: generate a JSON of appearance tokens (per-font size multiplier
  and line height from `src/lib/appearance/config.ts`, themes from
  `src/lib/theme/config.ts`, palettes from `src/app/globals.css`) and a
  standalone `reader-prose` stylesheet from the web build; the app build copies
  both, so the WebView body looks like the web's.
- WebView hardening, since an XSS there sits next to the OAuth token: no
  `addJavascriptInterface` that can reach credentials, a CSP allowing only the
  app's bundled highlight script, no file access, and all links open
  externally. Add it to `SECURITY.md`.
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
generated tokens/CSS change. Add `kmp/` to `.dockerignore` and knip's ignores.
Release tags `android-vX.Y.Z`. When the app lands, move these decisions into
`kmp/CLAUDE.md` and delete this file.

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

1. **Server groundwork** (TypeScript, testable with existing suites): the
   first-party app OAuth client + `/api/v1` audience + App Link redirect, app
   token access for the reader endpoints and SSE, `sync.changes` over
   `/api/v1` (next cursors, tombstones, resync), `entries.getMany`,
   `entries.setStarredMany` with per-entry timestamps, `changedAt` rebase +
   clamp, OpenAPI snapshot + CI breaking-change check. Each later phase adds the
   server pieces it needs alongside its client code.
2. **KMP skeleton + shared core**: Gradle setup, CI, generated or hand-written
   Ktor client, SQLDelight schema, sync, outbox, retention, JVM + real-server
   tests.
3. **Android MVP**: OAuth login, lists (all, unread, starred, saved,
   recently read, subscriptions, tags), entry view, read/star with swipe, offline
   indicator, background sync, appearance settings.
4. **Share target** + offline save queue + file uploads (server: app token
   access to `saved.*`, upload idempotency).
5. **Narration**: ExoPlayer/MediaSession with system and cloud voices, then
   Piper via sherpa-onnx (server: structured narration paragraphs + stamped
   HTML + plain-paragraph cache, binary synthesize, app token access).
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
