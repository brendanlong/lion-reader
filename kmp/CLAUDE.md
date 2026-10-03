# Kotlin Multiplatform app

`:shared` is the KMP core (`jvm`, Android and iOS targets), `:androidApp`
the Compose app; upcoming work is in `docs/native-app-plan.md`. The app is
**offline-first**: the UI reads only the local SQLDelight database (`Reader`),
which `SyncEngine` keeps in step with the server. The UI is native per
platform; only the article is a WebView (`ReaderWebView`, showing
`readerDocument`). Each signed-in account has **its own database**
(`Accounts`, `AccountSession`). How each part works is in the KDoc of the
class doing it.

## Rules

- Talk to the server only through `/api/v1` REST (contract
  `docs/api/openapi.json`; CI fails on breaking changes), never the tRPC wire
  format (superjson) or the Google Reader API.
- A known sync event that doesn't parse stops sync rather than lose the change
  (`parseSyncEvent`), so a new value in an enum an event carries (a feed type,
  say) breaks installed apps: add it as an optional field, or ship the app
  first.
- No custom URL scheme for sign-in: any app can register one and finish a
  sign-in under our client id. The redirect is a verified App Link.
- Token refresh is serialized through `AppAuth`'s mutex (refresh tokens rotate;
  reuse revokes the family), so the process shares `Accounts`' one `AppAuth`,
  and the new pair is on disk before it's used. Only a 400/401 from the token
  endpoint signs the user out; anything else is transient.
- SQL targets SQLite 3.18 (minSdk 26's), SQLDelight's default dialect: no
  UPSERT. Use insert-or-ignore + update, not `INSERT OR REPLACE`, which deletes
  the row (and its downloaded body, and gives it a new rowid, which the search
  index is keyed on).
- Open databases with `AppSchema` (`SearchIndex.kt`), never the generated
  `LionReaderDatabase.Schema`: it adds the search index's triggers.
- Database work never runs on the main thread. `Reader` switches to its own
  context; `SyncEngine` doesn't switch threads, so call it on IO.
- A list row is one TalkBack/Switch Access stop with its buttons as custom
  actions: a new row control needs a matching action. Where something changes
  without focus moving, a polite live region says what.
- Start `MainActivity` by its class, never by a launcher component name: the
  launcher entries are aliases and only one is enabled (`LauncherIcon.kt`).
  From adb: `adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1`
  (`am start -n` on `MainActivity` is refused).
- When the server's sync behavior changes, change `ModelServer` to match; keep
  `ServerLimits` (which it and `FakeServer` enforce) current too, or a fake
  hides a request the server would refuse.
- Anything looked up by name (reflection, serializers found at run time) needs
  a keep rule in `androidApp/proguard-rules.pro`: release builds use R8, and a
  missing rule only fails at run time.
- Generated files are regenerated, never edited:
  `assets/reader/narration.js` (`pnpm app:narration`, from
  `src/lib/narration/app-reader.ts`) and `assets/reader/appearance.json`
  (`pnpm app:appearance`, from `src/lib/appearance/config.ts`), both checked
  by unit tests; the fonts (`scripts/subset-fonts.py`) and launcher icon layers
  (`scripts/app-icon.py`, from `public/logo.svg`), whose headers say how.

## Commands

Run from `kmp/`. Gradle provisions its own JDK, so any JDK can launch
`./gradlew`; versions live only in `gradle/libs.versions.toml`. The Android SDK
comes from `sdk.dir` in `local.properties` (gitignored) or `ANDROID_HOME`.

- `./gradlew check` — the CI gate: Spotless, `:shared` tests (JVM and Android
  host) and iOS compilation, `:androidApp` Robolectric tests, Android lint.
- `./gradlew assembleDebug` — debug APK (`androidApp/build/outputs/apk/debug/`).
- `./gradlew spotlessApply` — format.
- `./gradlew :shared:jvmTest` — the fast loop for shared logic, including
  `SyncModelTest` (`SYNC_MODEL_SEEDS=20000` runs more seeds,
  `SYNC_MODEL_SEED=N` replays one).
- Real-server test: with a server running on the same database,
  `LION_READER_TEST_FIXTURE="$(NEXT_PUBLIC_APP_URL=<server url> pnpm -s app:test-fixture)" ./gradlew :shared:jvmTest`
  (fixture from the repo root; CI's `app-real-server-tests` job does this).

## Debug app and signing

Debug builds are a separate app, `com.lionreader.app.debug`, installable next
to the release one. To sign in to production, a debug build must be signed with
a private dev keystore whose fingerprint is in the server's
`ANDROID_DEBUG_APP_CERT_SHA256`. Never list Android's default debug key: its
password is public, and any key listed can act as the app at sign-in. Create
the keystore once, outside the repo and off shared hosts:

```bash
keytool -genkeypair -v -keystore lionreader-dev.jks -alias dev \
  -keyalg RSA -keysize 4096 -validity 10000
keytool -list -v -keystore lionreader-dev.jks -alias dev   # SHA256 line
```

and point Gradle at it with the properties `lionReaderDevKeystore` (path),
`lionReaderDevKeystorePassword`, `lionReaderDevKeyAlias` and
`lionReaderDevKeyPassword` (e.g. in `~/.gradle/gradle.properties` on your own
machine, or `ORG_GRADLE_PROJECT_*`). Without them, debug builds use the default
debug key and can sign in only to dev servers.

CI (`.github/workflows/android.yml`) signs its debug build with the same key
(secrets `ANDROID_DEV_KEYSTORE_BASE64`, `ANDROID_DEV_KEYSTORE_PASSWORD`,
`ANDROID_DEV_KEY_ALIAS`, `ANDROID_DEV_KEY_PASSWORD`) and links the APK from a
comment on the pull request, so a PR's build (not a fork's) or master's
installs over any other debug build. Anyone who can push a branch can read
those secrets (a workflow change can print them), which is why the key only
covers the debug app.

## Releases

How release builds are signed, versioned and shrunk, how to cut one, and how to
try R8 on a device: "Android app releases" in `docs/DEPLOYMENT.md`.

## Running against a dev server

Start the server with an issuer the phone can reach over USB, e.g.
`PORT=<port> NEXT_PUBLIC_APP_URL=http://localhost:<port> pnpm dev:local`, then
`adb reverse tcp:<port> tcp:<port>` and enter `http://localhost:<port>` on the
sign-in screen (only debug builds accept http). An http redirect can't be an
App Link, so sign-in ends on the server's "opened in your browser" page; for a
server on this machine, its **Open in the debug app** button hands the redirect
over (or `adb shell am start -a com.lionreader.app.DEBUG_SIGN_IN_CALLBACK -d
'<url>'` with the URL from the server's request log). `pnpm db:seed` creates
`test@example.com` / `password123`.

## Code quality

- Formatting is ktfmt (kotlinlang style) via Spotless, for `.kt` and `.kts`.
- Lint runs with `warningsAsErrors`; fix findings rather than baselining them.
  `lint.xml` holds the global suppressions; an in-code `@SuppressLint` needs a
  comment saying why.
- A schema change ships as a SQLDelight migration (`N.sqm`, from version N)
  plus the new version's schema (`N+1.db` in `sqldelight/databases/`, from
  `generateCommonMainLionReaderDatabaseSchema`); `check` fails unless migrating
  every `.db` matches a fresh database. A migration touching `entry` owes the
  search index what `AppSchema`'s KDoc says.
- Everything but the platform's UI and services goes in `:shared`'s
  `commonMain` (accounts, settings, view models, narration's rules, the reader
  document), so iOS gets the same behavior. What it needs from the platform
  comes in through an interface the app implements (`KeyValueStore`,
  `AccountStorage`, `BackgroundSync`) or a parameter (an IO dispatcher, the
  reader's asset origin), not `expect`/`actual`, unless it's a primitive like
  `secureRandomBytes`. `check` compiles the iOS targets (linking needs macOS),
  so JVM-only APIs in `commonMain` fail it.
- Shared tests go in `commonTest`; `jvmTest` is for what needs a JVM-only
  driver (e.g. SQLDelight's `JdbcSqliteDriver`) or reflection.
- Android UI tests run on Robolectric in `androidApp/src/test`, not on a device.
