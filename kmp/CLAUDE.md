# Kotlin Multiplatform app

`:shared` is the KMP core (`jvm` + Android targets; iOS later), `:androidApp`
the Compose app. Upcoming work (share targets, narration, iOS) is planned in
`docs/native-app-plan.md`.

## Architecture

- **Offline-first.** The UI reads only the local SQLDelight database
  (`shared/.../data/Reader.kt`); `SyncEngine` keeps it in step with the server.
  Native UI per platform over shared presenters-to-be; only the article (its
  header and body) is a WebView (entry HTML can hold MathML, SVG, tables,
  embeds). It fills the page and scrolls itself: sized to its content inside a
  scrolling layout, a WebView stays blank until it has measured.
- **API.** `/api/v1` REST, whose contract is `docs/api/openapi.json` (CI fails
  on breaking changes). Wire models (`api/Models.kt`) list only the fields the
  app uses and ignore unknown ones; sync events are parsed one by one so an
  event type newer than the app is skipped (`parseSyncEvent`). Never use the
  tRPC wire format (superjson) or the Google Reader API.
- **Auth.** OAuth 2.1 + PKCE against the server's built-in `lion-reader-app`
  client, in a Custom Tab; the redirect `https://<server>/oauth/app-callback`
  is claimed as a verified App Link (`assetlinks.json`, fed by
  `ANDROID_APP_CERT_SHA256` and, for the debug app, `ANDROID_DEBUG_APP_CERT_SHA256`
  on the server). Never a custom scheme: any app can
  register one and finish a sign-in under our client id. Refresh tokens rotate
  and the server revokes the family on reuse, so refresh is serialized
  (`AppAuth`'s mutex; the UI, WorkManager and the callback share one
  `AppGraph` and so one `AppAuth` — a new one is made only when a signed-out
  user picks another server) and the new pair is committed before use. Only
  400/401 from the token endpoint sign the user out.
- **One database per account.** `AppGraph` holds the server connection (auth,
  API) and the signed-in account's `AccountSession` (database, reader, sync),
  whose file is named for the server and the user id from `GET /auth/me`.
  Signing in to the same account keeps its data and unsent changes (an
  involuntary sign-out doesn't touch them); another account gets a fresh file
  and the previous one is deleted; signing out deletes it.
- **Local state vs. unsent changes.** `entry.read`/`starred` hold the last
  server state; the user's changes live in `outbox_state` (one row per entry
  and field, device timestamp) and win on display through `entry_view`. A
  flush deletes an outbox row only if it hasn't changed since it was sent.
- **The device shows what it has synced.** Unread counts are counted over the
  local entries (unsent changes included), never taken from the server, whose
  counts include unread entries outside the offline window that the app never
  shows. Mark-all-read likewise marks the unread entries of the list that are
  on the device (after a confirmation showing that count), not everything the
  server has.
- **Sync: fetch, then commit.** `SyncEngine` does the network work and hands
  complete results to `SyncWriter`, whose methods are one transaction each,
  don't suspend and can't reach the API, so a cursor can't be committed ahead
  of data a later request was meant to bring. The first download saves
  subscriptions, tags and the entry lists (newest first) page by page, and
  resumes from its start cursors if interrupted; then `sync.changes` deltas,
  each page committing with its next cursors. Entries an event mentions but the
  device lacks are fetched whole. So are ones it has when the event calls them
  new: a bootstrap listed them, and they may have been edited since (#1680).
  Past the first page of a catch-up, every one it has is fetched too: the app
  doesn't send `entriesSince`, so the server classifies changes against each
  page's own cursor and can report a new entry as updated or drop an edit
  (#1663).
  `deletions` drop entries.
  `resyncRequired` re-bootstraps, keeping the outbox. Read/starred state comes
  only from deltas, fetched entries and flush responses. A flush is followed by
  a pull.
- **Article bodies** live in `entry_body`, written only by `storeBodies`, and
  download after the lists, newest first, outside the sync lock, so refreshes and flushes never wait for them. Background
  downloads take turns under their own lock; opening an entry fetches its body
  straight away, alongside them. A body
  is stored only if its entry still exists at the `body_version` it had when
  the download started (an edit bumps it, and versions never repeat, even
  when an entry is deleted and added again), so a download racing a deletion or
  an edit can't leave a missing or stale body. Pull-to-refresh syncs the lists
  and leaves bodies to a background job.
- **Narration** runs the web's own code in the reader: `narration.js` is
  bundled from `src/lib/narration/app-reader.ts` (`pnpm app:narration`; a unit
  test fails when stale), so the app numbers, speaks and highlights an article
  exactly as the web does, offline included. `Narrator` has a `SpeechEngine`
  (the device's text-to-speech, or cloud voices through the server) synthesize
  it a little ahead into files and plays them through one ExoPlayer, which
  `NarrationService` puts in a media session (notification, lock screen,
  headset buttons, background playback). Engines are only sources of audio
  files, each with its chunk size, lookahead and parallelism; playback,
  highlighting and seeking don't change per engine. Cloud audio is cached on
  disk by model, voice and text, so listening again is free.
- **Share target** (`share/`): a shared link is saved by a WorkManager job
  (`SaveWorker`), not the dialog, so it survives the dialog closing and waits
  for a network however long the device is offline; it gives up only when the
  server rejects the link. The dialog only follows the job.
- **AI summaries** are fetched only when the user asks (the server generates
  and caches them with the user's web settings) and then kept in
  `entry_summary` for offline reading while their entry is on the device.
  Like bodies, one is stored only if its entry is still at the `body_version`
  it had when the request started, and an edit drops it.
- **Retention** (`RetentionPolicy`): entries outside the window go, at most N
  read entries stay, bodies are capped by size (oldest read first); starred,
  saved and entries with unsent changes are always kept.
- **Database work never runs on the main thread**: `Reader`'s writes are
  `suspend` and run on its context (IO in the app); `SyncEngine` doesn't switch
  threads, so the UI calls it on IO.
- **Reader view.** Hardened per SECURITY.md §1; the body is the server's
  sanitized HTML, inserted verbatim. Its one script reports where wide tables
  and code blocks are, so a sideways drag on one scrolls it instead of paging
  (`ReaderView`).
- **Appearance tokens** (`androidApp/src/main/assets/reader/appearance.json`)
  are generated from the web's `src/lib/appearance/config.ts` by
  `pnpm app:appearance` (a unit test fails when stale). Fonts are OFL Google
  Fonts subset to Latin woff2 by `scripts/subset-fonts.py` (its header says how
  to run it).
- **Launcher icon** layers (`res/mipmap-*`) are generated from the repo-root
  `assets/logo-original.svg` by `scripts/app-icon.py` (its header says how).
  Debug builds get their own background color so they're easy to tell apart,
  except with themed icons on, which use only the monochrome layer.
- **Background sync** runs through WorkManager (`SyncScheduler`): a periodic
  full sync and a flush after each user change, both waiting for a network.

## Setup

Gradle provisions its own JDK (`gradle/gradle-daemon-jvm.properties` plus the
`jdk` toolchain version in `gradle/libs.versions.toml`), so any JDK can launch
`./gradlew`. Versions live only in the catalog; its header says which Kotlin /
AGP / Gradle combinations are supported.

The Android SDK comes from `sdk.dir` in `kmp/local.properties` (gitignored) or
`ANDROID_HOME`. Without Android Studio, install it from Google's command-line
tools (not the unrelated Debian `/usr/bin/sdkmanager`):

```bash
SDK=/path/outside/the/repo/android-sdk   # e.g. next to the worktree
mkdir -p "$SDK/cmdline-tools" && cd "$SDK"
curl -sSLo tools.zip https://dl.google.com/android/repository/commandlinetools-linux-16111833_latest.zip
unzip -q tools.zip -d cmdline-tools && mv cmdline-tools/cmdline-tools cmdline-tools/latest && rm tools.zip
yes | cmdline-tools/latest/bin/sdkmanager --sdk_root="$SDK" \
  "platform-tools" "platforms;android-37.0" "build-tools;36.0.0"
echo "sdk.dir=$SDK" > <repo>/kmp/local.properties
```

On a shared host, keep tool state out of `$HOME`: `JAVA_TOOL_OPTIONS=-Duser.home=<dir>`
for `sdkmanager`, and for Gradle `GRADLE_USER_HOME=<dir>` plus
`ANDROID_PREFS_ROOT=<dir>` (AGP writes `analytics.settings` to `~/.android`
unless that is set; `ANDROID_USER_HOME` does not cover it, and setting both
fails the build).

## Commands

Run from `kmp/`:

- `./gradlew check` — the CI gate: Spotless, `:shared` tests (JVM and Android
  host), `:androidApp` Robolectric tests, Android lint.
- `./gradlew assembleDebug` — debug APK (`androidApp/build/outputs/apk/debug/`).
- `./gradlew spotlessApply` — format.
- `./gradlew :shared:jvmTest` — the fast loop for shared logic. It includes
  `SyncModelTest`: random histories (local and remote changes, flaky and lost
  requests, overlapping syncs, restarts) against `ModelServer`, a model of the
  server's sync semantics, checked for convergence, no lost changes, correct
  counts and current bodies. `SYNC_MODEL_SEEDS=20000` runs more;
  `SYNC_MODEL_SEED=N` replays one failure and prints its requests. When the
  server's sync behavior changes, change `ModelServer` to match.
- Real-server test: with a server running on the same database,
  `LION_READER_TEST_FIXTURE="$(NEXT_PUBLIC_APP_URL=<server url> pnpm -s app:test-fixture)" ./gradlew :shared:jvmTest`
  (repo root for the fixture; CI's `app-real-server-tests` job does exactly
  this). Without the variable `RealServerTest` skips itself.

## Debug app and signing

Debug builds are a separate app, `com.lionreader.app.debug` ("Lion Reader
(debug)"), installable next to the release app. For a debug build to sign in to
production, sign it with a private dev keystore and list that key's fingerprint
in `ANDROID_DEBUG_APP_CERT_SHA256`. Never list Android's default debug key: its
password is public, and any key listed can act as the app at sign-in. Create
the keystore once, keep it outside the repo and off shared hosts:

```bash
keytool -genkeypair -v -keystore lionreader-dev.jks -alias dev \
  -keyalg RSA -keysize 4096 -validity 10000
keytool -list -v -keystore lionreader-dev.jks -alias dev   # SHA256 line
```

and point Gradle at it with properties (e.g. in `~/.gradle/gradle.properties`
on your own machine, or `ORG_GRADLE_PROJECT_*` variables): `lionReaderDevKeystore`
(path), `lionReaderDevKeystorePassword`, `lionReaderDevKeyAlias`,
`lionReaderDevKeyPassword`. Without them, debug builds use the default debug
key and can sign in only to dev servers. With both apps installed, Android
may ask which one opens the sign-in redirect; picking the other one just fails
that sign-in (PKCE), so retry.

## Running against a dev server

Start the app with an issuer the phone can reach over USB, e.g.
`PORT=<port> NEXT_PUBLIC_APP_URL=http://localhost:<port> pnpm dev:local`, then
`adb reverse tcp:<port> tcp:<port>` and enter `http://localhost:<port>` as the
server on the sign-in screen (debug builds allow cleartext). An http redirect
can't be an App Link, so the sign-in ends on the server's "opened in your
browser" page; hand the redirect to the app yourself:

```bash
adb shell am start -n com.lionreader.app.debug/com.lionreader.app.MainActivity -a com.lionreader.app.DEBUG_SIGN_IN_CALLBACK \
  -d "'http://localhost:<port>/oauth/app-callback?code=...&state=...'"
```

(the URL is in the dev server's request log). `pnpm db:seed` creates
`test@example.com` / `password123`.

## Code quality

- Formatting is ktfmt (kotlinlang style) via Spotless, for `.kt` and `.kts`.
- Lint runs with `warningsAsErrors`; fix findings rather than baselining them.
  `lint.xml` holds the global suppressions (the "newer version available"
  checks, which would fail an unchanged tree whenever upstream ships); an
  in-code `@SuppressLint` needs a comment saying why.
- Until a build is released, a schema change bumps the generation in the
  database file name (`DB_PREFIX` in `AppGraph.kt`) instead of shipping a
  migration: older files are deleted and the account resyncs. After release,
  schema changes need SQLDelight migrations (`.sqm`).
- SQL targets SQLite 3.18 (minSdk 26's), SQLDelight's default dialect: no
  UPSERT (`ON CONFLICT DO UPDATE`) — use insert-or-ignore + update, not
  `INSERT OR REPLACE`, which deletes the row (and its downloaded body).
- Shared logic goes in `commonMain` with tests in `commonTest`; `jvmTest` is for
  what needs a JVM-only driver (e.g. SQLDelight's in-memory `JdbcSqliteDriver`).
- Android UI tests run on Robolectric in `androidApp/src/test`, not on a device.
