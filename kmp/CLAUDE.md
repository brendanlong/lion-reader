# Kotlin Multiplatform app

`:shared` is the KMP core (`jvm` + Android targets; iOS later), `:androidApp`
the Compose app. Upcoming work (share targets, narration, iOS) is planned in
`docs/native-app-plan.md`.

## Architecture

- **Offline-first.** The UI reads only the local SQLDelight database
  (`shared/.../data/Reader.kt`); `SyncEngine` keeps it in step with the server.
  Native UI per platform over shared presenters-to-be; only the article body is
  a WebView (entry HTML can hold MathML, SVG, tables, embeds).
- **API.** `/api/v1` REST, whose contract is `docs/api/openapi.json` (CI fails
  on breaking changes). Wire models (`api/Models.kt`) list only the fields the
  app uses and ignore unknown ones; sync events are parsed one by one so an
  event type newer than the app is skipped (`parseSyncEvent`). Never use the
  tRPC wire format (superjson) or the Google Reader API.
- **Auth.** OAuth 2.1 + PKCE against the server's built-in `lion-reader-app`
  client, in a Custom Tab; the redirect `https://<server>/oauth/app-callback`
  is claimed as a verified App Link (`assetlinks.json`, fed by
  `ANDROID_APP_CERT_SHA256` on the server). Never a custom scheme: any app can
  register one and finish a sign-in under our client id. Refresh tokens rotate
  and the server revokes the family on reuse, so refresh is serialized
  (`AppAuth`'s mutex; one `AppAuth` per process — the UI, WorkManager and the
  callback share `AppGraph`) and the new pair is committed before use. Only
  400/401 from the token endpoint sign the user out.
- **Local state vs. unsent changes.** `entry.read`/`starred` hold the last
  server state; the user's changes live in `outbox_state` (one row per entry
  and field, device timestamp) and win on display through `entry_view`. Unread
  counts are the server's absolute counts plus corrections computed from the
  outbox at query time (`readAdjustments`), so a server response can overwrite
  counts without double-counting. A flush deletes an outbox row only if it
  hasn't changed since it was sent. Mark-all-read is its own outbox row whose
  `before` is a server `fetchedAt` the device had seen.
- **Sync.** Cursors first, then the initial window (entries, starred, saved,
  subscriptions, tags, counts), then `sync.changes` deltas; each page's data
  and next cursors commit in one transaction. `deletions` drop entries,
  `resyncRequired` re-bootstraps without touching the outbox, and a
  resubscribed feed gets a scoped refetch (its old entries predate the
  cursor). Outbox requests the server rejects (400/404/422) are dropped so one
  bad item can't stall the queue; anything else is retried.
- **Retention** (`RetentionPolicy`): entries outside the window go, bodies are
  capped by size (oldest read first); starred, saved and entries with unsent
  changes are always kept.
- **Reader view.** JavaScript off, no file/content access, no JS bridge, every
  link opens outside the app, bundled fonts served by `WebViewAssetLoader`.
  The body is the server's sanitized HTML, inserted verbatim.
- **Appearance tokens** (`androidApp/src/main/assets/reader/appearance.json`)
  are generated from the web's `src/lib/appearance/config.ts` by
  `pnpm app:appearance` (a unit test fails when stale). Fonts are OFL Google
  Fonts subset to Latin woff2 by `scripts/subset-fonts.py` (its header says how
  to run it).
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
- `./gradlew :shared:jvmTest` — the fast loop for shared logic.
- Real-server test: with a server running on the same database,
  `LION_READER_TEST_FIXTURE="$(NEXT_PUBLIC_APP_URL=<server url> pnpm -s app:test-fixture)" ./gradlew :shared:jvmTest`
  (repo root for the fixture; CI's `app-real-server-tests` job does exactly
  this). Without the variable `RealServerTest` skips itself.

## Running against a dev server

Start the app with an issuer the phone can reach over USB, e.g.
`PORT=<port> NEXT_PUBLIC_APP_URL=http://localhost:<port> pnpm dev:local`, then
`adb reverse tcp:<port> tcp:<port>` and enter `http://localhost:<port>` as the
server on the sign-in screen (debug builds allow cleartext). An http redirect
can't be an App Link, so the sign-in ends on the server's "opened in your
browser" page; hand the redirect to the app yourself:

```bash
adb shell am start -n com.lionreader.app/.MainActivity -a android.intent.action.VIEW \
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
- SQL targets SQLite 3.18 (minSdk 26's), SQLDelight's default dialect: no
  UPSERT (`ON CONFLICT DO UPDATE`) — use insert-or-ignore + update, not
  `INSERT OR REPLACE`, which deletes the row (and its downloaded body).
- Shared logic goes in `commonMain` with tests in `commonTest`; `jvmTest` is for
  what needs a JVM-only driver (e.g. SQLDelight's in-memory `JdbcSqliteDriver`).
- Android UI tests run on Robolectric in `androidApp/src/test`, not on a device.
