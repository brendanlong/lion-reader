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
  event type newer than the app is skipped (`parseSyncEvent`). A known event
  that doesn't parse stops sync rather than be lost, so a new value in an enum
  an event carries (a feed type, say) breaks installed apps: add it as an
  optional field, or ship the app first. Never use the
  tRPC wire format (superjson) or the Google Reader API.
- **Auth.** OAuth 2.1 + PKCE against the server's built-in `lion-reader-app`
  client, in an Auth Tab (which hands the redirect straight back to the app
  that opened it; a browser without them opens a Custom Tab). The redirect
  `https://<server>/oauth/app-callback` (the debug app's:
  `/oauth/app-callback/debug`, so the two apps never compete for one) is
  claimed as a verified App Link (`assetlinks.json`, fed by
  `ANDROID_APP_CERT_SHA256` and, for the debug app,
  `ANDROID_DEBUG_APP_CERT_SHA256` on the server). Never a custom scheme: any
  app can register one and finish a sign-in under our client id. Refresh tokens rotate
  and the server revokes the family on reuse, so refresh is serialized
  (`AppAuth`'s mutex; the UI, WorkManager and the callback share one
  `AppGraph` and so one `AppAuth` — a new one is made only when a signed-out
  user picks another server) and the new pair is committed before use. Only
  400/401 from the token endpoint sign the user out. The pending request is
  kept on disk and the code exchange runs in `AppGraph`'s scope, so a sign-in
  survives the Activity going away behind the browser. Only debug builds take
  an http server (`parseServerUrl`), for dev servers on localhost.
- **One database per account.** `AppGraph` holds the server connection (auth,
  API) and the signed-in account's `AccountSession` (database, reader, sync),
  whose file is named for the server and the user id from `GET /auth/me`.
  Signing in to the same account keeps its data and unsent changes (an
  involuntary sign-out doesn't touch them); another account gets a fresh file
  and the previous one is deleted; signing out deletes it (after trying to
  send the unsent changes, and asking before losing any), and then the
  tokens, before revoking them. Start-up deletes any other account's file
  (one a sign-out or switch didn't live to finish). A kept account isn't shown
  or synced after a new sign-in until `/auth/me` says the tokens are its
  (`AccountSession.confirmed`): they may be someone else's. A closed session's
  database turns any further use into a cancellation (`SessionDriver`), since
  screens and syncs can still be running on it.
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
  each page committing with its next cursors. Every page of a catch-up also
  sends the cursors the catch-up started from (`entriesSince`, kept until its
  last page), which the server classifies changes against (#1663). Entries an
  event mentions but the device lacks are fetched whole, and so are ones it has
  when the event calls them new: a bootstrap listed them, and they may have
  been edited since (#1680). Spam isn't fetched: the server sends it without
  its data so that clients leave it out, as its lists do. `deletions` drop
  entries.
  `resyncRequired` re-bootstraps, keeping the outbox. Read/starred state comes
  only from deltas, fetched entries and flush responses. A flush is followed by
  a pull, even when it fails.
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
  it a little ahead and plays the chunks through one ExoPlayer, which
  `NarrationService` puts in a media session (notification, lock screen,
  headset buttons, background playback). Engines are only sources of audio,
  each with its chunk size, lookahead and parallelism; playback, highlighting
  and seeking don't change per engine. Cloud audio streams: a chunk plays from
  its first bytes while the rest arrives (`StreamedAudio`), and one that stops
  partway is synthesized again and replayed from its start. It's cached on
  disk by model, voice, pause and text, so listening again is free. Narration, once
  on, is of the article on screen: swiping silences it at once and moves it to
  the new article, playing or paused as it was, and closing the article view
  stops it (`NarrationFollowsPage`).
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
  saved and entries with unsent changes are always kept, and an entry read
  within the window counts as recent however old it is.
- **Recently Read** orders entries by when their read state last changed: the
  server's time, unless an unsent change is later. Opening an entry marks it
  read even if it is already, as on the web. Re-marking an entry read moves the
  server's time without counting as a change to sync (#1118), so every sync
  also pages through the server's list down to what it saw last time (the
  first, back through the window).
- **Database work never runs on the main thread**: `Reader`'s writes are
  `suspend` and run on its context (IO in the app); `SyncEngine` doesn't switch
  threads, so the UI calls it on IO.
- **Wide screens** show the list and the article side by side (Navigation 3's
  `ListDetailSceneStrategy`: home is the list pane, an entry the detail). So
  opening from the list replaces the entry on the back stack rather than
  stacking another, back closes the article beside the list (`PopLatest`),
  and the list highlights the article shown.
- **Accessibility:** a list row is one TalkBack/Switch Access stop, with
  its buttons (and the swipe) as custom actions and the buttons themselves
  hidden from accessibility services. A new row control needs a matching
  action. A switch and its label are one stop too (`SettingSwitch`). Where something
  changes without focus moving (the reader's pager, a sign-in error), a polite
  live region says what changed.
- **Reader view.** Hardened per SECURITY.md §1; the body is the server's
  sanitized HTML, inserted verbatim. As on the web, only a drag at least twice
  as far sideways as vertical turns the page (judged over its first few dp,
  with the pager waiting for twice the usual touch slop so the reader decides
  first), so a scroll can't turn into a page turn (`ReaderView`). A script reports where
  wide tables and code blocks are, so a sideways drag on one scrolls it
  instead.
- **E-reader options** (Settings → E-readers). Animations go off app-wide, not one
  by one: the window's recomposer gets the app's own animation scale (`AppMotion`,
  zero when off), so every Compose animation jumps to its end. Only what that
  scale doesn't reach needs its own switch: the screen transitions (predictive
  back follows the finger), the article pager's fling snap, and the reader's
  scroll to the narrated paragraph. Page mode turns pages rather than scrolling
  (`pageSwipes`; `ReaderView` for the article, leaving a long press's drag to the
  text selection), and the volume buttons turn the page of the top `PageTurns`
  target. A known e-reader maker (`isEinkDevice`; Android can't report an
  e-ink screen) starts on the E-paper theme without animations: those are the
  device's defaults (two separate settings), which anything the user sets
  overrides.
- **Appearance tokens** (`androidApp/src/main/assets/reader/appearance.json`)
  are generated from the web's `src/lib/appearance/config.ts` by
  `pnpm app:appearance` (a unit test fails when stale). Fonts are OFL Google
  Fonts subset to Latin woff2 by `scripts/subset-fonts.py` (its header says how
  to run it).
- **Launcher icon** layers (`res/mipmap-*`) are generated from the repo-root
  `public/logo.svg` by `scripts/app-icon.py` (its header says how).
  Debug builds get their own background color so they're easy to tell apart,
  except with themed icons on, which use only the monochrome layer.
- **Background sync** runs through WorkManager (`SyncScheduler`): a periodic
  full sync and a flush after each user change, both waiting for a network.
- **Live updates:** while the app is on screen it listens to the server's
  events stream (`/api/v1/events`, `followLiveUpdates`) and pulls when it says
  the account's data changed. The events only trigger the pull: everything
  still comes through the one sync. In the background it's the periodic sync
  alone.

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
  server's sync behavior changes, change `ModelServer` to match. Both it and
  `FakeServer` reject requests over the real endpoints' size limits
  (`ServerLimits`): keep those current too, or a fake hides a request the
  server would refuse.
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
key and can sign in only to dev servers.

CI (`.github/workflows/android.yml`) signs its debug build with the same key,
from the `ANDROID_DEV_KEYSTORE_BASE64`, `ANDROID_DEV_KEYSTORE_PASSWORD`,
`ANDROID_DEV_KEY_ALIAS` and `ANDROID_DEV_KEY_PASSWORD` secrets, and attaches the
APK to the run (linked from a comment on the pull request), so the Android build
of a PR (from this repository, not a fork) or of master is installable over any
other debug build. Anyone who can push a branch to the repository can read those
secrets (a workflow change can print them), which is why the key only covers the
debug app.

## Releases

Release builds are signed with the upload key from CI secrets, versioned from
their `android-vX.Y.Z` tag, and shrunk with R8 (setup and steps: "Android app
releases" in `docs/DEPLOYMENT.md`). Libraries bring their own keep rules;
`androidApp/proguard-rules.pro` covers what our code reaches by name, such as
the `NavKey`s the saved back stack restores. Anything new that's looked up by
name (reflection, serializers found at runtime) needs a rule there. CI builds
the release variant on every pull request, so R8 errors show up early, but
missing keep rules only fail at run time. To try R8 on a device against a dev
server, add a throwaway build type (not committed) with release's R8 and the
debug app's identity, so it installs over the debug app and can reach http:

```kotlin
create("r8test") {
    initWith(getByName("release"))
    applicationIdSuffix = ".debug"
    signingConfig = devSigning
    matchingFallbacks += listOf("release")
}
// after buildTypes:
sourceSets.getByName("r8test").manifest.srcFile("src/debug/AndroidManifest.xml")
```

then `./gradlew :androidApp:assembleR8test`. (Debug builds with R8 turned on
don't test it: debuggable builds skip R8's renaming.)

## Running against a dev server

Start the app with an issuer the phone can reach over USB, e.g.
`PORT=<port> NEXT_PUBLIC_APP_URL=http://localhost:<port> pnpm dev:local`, then
`adb reverse tcp:<port> tcp:<port>` and enter `http://localhost:<port>` as the
server on the sign-in screen (debug builds allow cleartext). An http redirect
can't be an App Link, so the sign-in ends on the server's "opened in your
browser" page; on a server on this machine that page has an **Open in the debug
app** button that hands the redirect over (it's also the URL in the dev
server's request log, for `adb shell am start -a
com.lionreader.app.DEBUG_SIGN_IN_CALLBACK -d '<url>'`). `pnpm db:seed` creates
`test@example.com` / `password123`.

## Code quality

- Formatting is ktfmt (kotlinlang style) via Spotless, for `.kt` and `.kts`.
- Lint runs with `warningsAsErrors`; fix findings rather than baselining them.
  `lint.xml` holds the global suppressions (the "newer version available"
  checks, which would fail an unchanged tree whenever upstream ships); an
  in-code `@SuppressLint` needs a comment saying why.
- A schema change ships as a SQLDelight migration (`N.sqm`, from version N),
  plus the new version's schema (`N+1.db` in `sqldelight/databases/`, from
  `generateCommonMainLionReaderDatabaseSchema`). `check` migrates every `.db`
  there and fails unless the result matches a fresh database.
- SQL targets SQLite 3.18 (minSdk 26's), SQLDelight's default dialect: no
  UPSERT (`ON CONFLICT DO UPDATE`) — use insert-or-ignore + update, not
  `INSERT OR REPLACE`, which deletes the row (and its downloaded body, and
  gives it a new rowid, which the search index is keyed on).
- Open databases with `AppSchema` (`SearchIndex.kt`), never the generated
  `LionReaderDatabase.Schema`: it adds the search index's triggers. Its docs
  say what a migration touching `entry` owes the index. Search covers
  everything on the device, read or not, and nothing else.
- Shared logic goes in `commonMain` with tests in `commonTest`; `jvmTest` is for
  what needs a JVM-only driver (e.g. SQLDelight's in-memory `JdbcSqliteDriver`).
- Android UI tests run on Robolectric in `androidApp/src/test`, not on a device.
