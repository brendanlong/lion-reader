# Kotlin Multiplatform app

Architecture and decisions: `docs/native-app-plan.md`. `:shared` is the KMP
core (`jvm` + Android targets), `:androidApp` the Compose app.

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

## Code quality

- Formatting is ktfmt (kotlinlang style) via Spotless, for `.kt` and `.kts`.
- Lint runs with `warningsAsErrors`; fix findings rather than baselining them.
  `lint.xml` holds the only suppressions (the "newer version available" checks,
  which would fail an unchanged tree whenever upstream ships).
- Shared logic goes in `commonMain` with tests in `commonTest`; `jvmTest` is for
  what needs a JVM-only driver (e.g. SQLDelight's in-memory `JdbcSqliteDriver`).
- Android UI tests run on Robolectric in `androidApp/src/test`, not on a device.
