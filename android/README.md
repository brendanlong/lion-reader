# Lion Reader Android App

Native Android client for Lion Reader, an RSS feed reader application.

## Table of Contents

- [Requirements](#requirements)
- [Project Structure](#project-structure)
- [Development Setup](#development-setup)
- [Build Instructions](#build-instructions)
- [Build Variants](#build-variants)
- [Release Process](#release-process)
- [Keystore Setup](#keystore-setup)
- [Error Monitoring (Sentry)](#error-monitoring-sentry)
- [Play Store Listing](#play-store-listing)
- [Architecture](#architecture)

## Requirements

- **Android Studio**: Ladybug (2024.2.1) or newer
- **JDK**: 17 or newer
- **Gradle**: 8.x (bundled with project)
- **Android SDK**: API 34 (compile SDK), API 26 (minimum SDK)
- **Kotlin**: 2.0+

## Project Structure

```
android/
├── app/
│   ├── src/
│   │   ├── main/
│   │   │   ├── java/com/lionreader/
│   │   │   │   ├── data/           # Data layer (API, DB, repositories)
│   │   │   │   ├── di/             # Dependency injection modules
│   │   │   │   ├── service/        # Background services
│   │   │   │   ├── ui/             # UI layer (screens, components)
│   │   │   │   ├── LionReaderApp.kt
│   │   │   │   └── MainActivity.kt
│   │   │   ├── res/                # Android resources
│   │   │   └── AndroidManifest.xml
│   │   ├── test/                   # Unit tests
│   │   └── androidTest/            # Instrumented tests
│   ├── build.gradle.kts
│   └── proguard-rules.pro
├── gradle/
│   └── libs.versions.toml          # Version catalog
├── build.gradle.kts
├── settings.gradle.kts
└── gradle.properties
```

## Development Setup

### 1. Clone the Repository

```bash
git clone <repository-url>
cd lion-reader/android
```

### 2. Install Android SDK

#### Option A: Android Studio (Recommended for development)

Open the `android/` directory in Android Studio. The IDE will automatically sync Gradle and download dependencies.

#### Option B: Command-Line Tools (Ubuntu/Linux)

For headless environments or if you prefer not to use Android Studio:

```bash
# Install JDK and SDK manager
sudo apt update
sudo apt install openjdk-17-jdk sdkmanager

# Create SDK directory
# Note: ANDROID_HOME is already set by android/.envrc if you use direnv
export ANDROID_HOME=$HOME/Android/Sdk
mkdir -p $ANDROID_HOME

# Accept licenses and install required SDK components
sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

If you're not using direnv, add to your `~/.bashrc` or `~/.zshrc`:

```bash
export ANDROID_HOME=$HOME/Android/Sdk
export PATH=$PATH:$ANDROID_HOME/platform-tools
```

### 3. Configure Local Properties (Optional)

For release builds, create or edit `local.properties` in the Android project root:

```properties
# SDK path (usually auto-configured)
sdk.dir=/path/to/android/sdk

# Release keystore configuration (optional, for local release builds)
LION_READER_KEYSTORE_PATH=/path/to/your/keystore.jks
LION_READER_KEYSTORE_PASSWORD=your_keystore_password
LION_READER_KEY_ALIAS=your_key_alias
LION_READER_KEY_PASSWORD=your_key_password
```

### 4. Run the App

- **Debug build**: Select the `debug` build variant and run on device/emulator
- **Release build**: Requires keystore configuration (see [Keystore Setup](#keystore-setup))

## Build Instructions

### Debug Build

```bash
# Build debug APK
./gradlew assembleDebug

# Build and install on connected device
./gradlew installDebug

# Run all tests
./gradlew test

# Run instrumented tests
./gradlew connectedAndroidTest
```

### Release Build

```bash
# Build release APK (requires signing configuration)
./gradlew assembleRelease

# Build release bundle for Play Store
./gradlew bundleRelease
```

### Code Quality

```bash
# Run ktlint check
./gradlew ktlintCheck

# Auto-format with ktlint
./gradlew ktlintFormat

# Run detekt static analysis
./gradlew detekt

# Run all checks
./gradlew check
```

## Build Variants

The app has two build variants:

### Debug

- **Application ID**: `com.lionreader.debug`
- **Version name suffix**: `-debug`
- **Minification**: Disabled
- **Logging**: Enabled (`BuildConfig.LOGGING_ENABLED = true`)
- **Signing**: Uses default Android debug keystore

Use for development and testing. Can be installed alongside the release version.

### Release

- **Application ID**: `com.lionreader`
- **Minification**: Enabled (R8)
- **Resource shrinking**: Enabled
- **Logging**: Disabled (`BuildConfig.LOGGING_ENABLED = false`)
- **Signing**: Requires release keystore configuration

Use for production distribution via Play Store or direct APK distribution.

### Configuring Build-Specific Values

Build-specific values are configured in `app/build.gradle.kts`:

```kotlin
buildTypes {
    debug {
        buildConfigField("String", "API_BASE_URL", "\"https://your-staging-api.com\"")
        buildConfigField("boolean", "LOGGING_ENABLED", "true")
    }
    release {
        buildConfigField("String", "API_BASE_URL", "\"https://lion-reader.fly.dev\"")
        buildConfigField("boolean", "LOGGING_ENABLED", "false")
    }
}
```

Access in code via `BuildConfig.API_BASE_URL` and `BuildConfig.LOGGING_ENABLED`.

## Release Process

### 1. Pre-Release Checklist

- [ ] All tests passing (`./gradlew test connectedAndroidTest`)
- [ ] Code quality checks passing (`./gradlew check`)
- [ ] Version code and name updated in `app/build.gradle.kts`
- [ ] CHANGELOG updated with release notes
- [ ] Release keystore properly configured

### 2. Version Management

Version is configured in `app/build.gradle.kts`:

```kotlin
val versionMajor = 1  // Major version (breaking changes)
val versionMinor = 0  // Minor version (new features)
val versionPatch = 0  // Patch version (bug fixes)
val versionBuild = 1  // Build number (increment each build)
```

- **versionCode**: Calculated as `major*10000 + minor*1000 + patch*100 + build`
- **versionName**: Formatted as `major.minor.patch`

### 3. Build Release Bundle

```bash
# Build App Bundle for Play Store
./gradlew bundleRelease

# Output: app/build/outputs/bundle/release/app-release.aab
```

### 4. Build Release APK (for direct distribution)

```bash
# Build signed APK
./gradlew assembleRelease

# Output: app/build/outputs/apk/release/app-release.apk
```

### 5. Test Release Build

Before uploading to Play Store:

1. Install the release APK/bundle on a test device
2. Verify all features work correctly
3. Check ProGuard/R8 has not broken any functionality
4. Test on multiple API levels if possible

## Keystore Setup

**Important**: Never commit keystore files or passwords to version control.

### Creating a New Keystore

```bash
keytool -genkey -v \
  -keystore lion-reader-release.jks \
  -keyalg RSA \
  -keysize 2048 \
  -validity 10000 \
  -alias lion-reader
```

You will be prompted for:

- Keystore password
- Key alias password
- Certificate details (name, organization, location)

### Configuring Signing

#### Option 1: Environment Variables (Recommended for CI/CD)

```bash
export LION_READER_KEYSTORE_PATH=/path/to/lion-reader-release.jks
export LION_READER_KEYSTORE_PASSWORD=your_keystore_password
export LION_READER_KEY_ALIAS=lion-reader
export LION_READER_KEY_PASSWORD=your_key_password
```

#### Option 2: local.properties (Local Development)

Add to `android/local.properties`:

```properties
LION_READER_KEYSTORE_PATH=/absolute/path/to/lion-reader-release.jks
LION_READER_KEYSTORE_PASSWORD=your_keystore_password
LION_READER_KEY_ALIAS=lion-reader
LION_READER_KEY_PASSWORD=your_key_password
```

**Note**: `local.properties` is in `.gitignore` and should never be committed.

### Keystore Best Practices

1. **Backup your keystore**: Store it securely outside the repository
2. **Use strong passwords**: Different passwords for keystore and key
3. **Document access**: Keep record of who has access to the keystore
4. **Secure storage**: Use a password manager or secrets vault (e.g., 1Password, HashiCorp Vault)
5. **Google Play App Signing**: Consider enrolling in Play App Signing for additional protection

### CI/CD Integration

For GitHub Actions or other CI/CD systems:

1. Base64 encode the keystore:

   ```bash
   base64 -i lion-reader-release.jks -o keystore_base64.txt
   ```

2. Store as secrets in your CI system:
   - `KEYSTORE_BASE64`: The base64-encoded keystore
   - `KEYSTORE_PASSWORD`: Keystore password
   - `KEY_ALIAS`: Key alias
   - `KEY_PASSWORD`: Key password

3. In CI, decode and use:
   ```bash
   echo "$KEYSTORE_BASE64" | base64 -d > lion-reader-release.jks
   export LION_READER_KEYSTORE_PATH=$(pwd)/lion-reader-release.jks
   ```

## Error Monitoring (Sentry)

The app integrates [Sentry](https://sentry.io/) for crash reporting and performance monitoring in production builds.

### Features

- **Crash Reporting**: Automatic capture of unhandled exceptions
- **Performance Monitoring**: Transaction tracing with 100% sample rate
- **Source Context**: Stack traces include source code snippets
- **Auto-Instrumentation**: Database, File I/O, OkHttp, and Compose operations
- **ProGuard Mapping**: Automatic upload for deobfuscated stack traces

### Configuration

Sentry is **disabled by default** and only activates when a valid DSN is provided. It is also disabled in debug builds to avoid noise during development.

#### Required Environment Variables

| Variable | Description |
|----------|-------------|
| `SENTRY_DSN` | Sentry project DSN (e.g., `https://xxx@yyy.ingest.sentry.io/zzz`) |
| `SENTRY_AUTH_TOKEN` | Auth token for uploading source maps and ProGuard mappings |
| `SENTRY_ORG` | Sentry organization slug |
| `SENTRY_PROJECT` | Sentry project slug |

#### Getting Sentry Credentials

1. **SENTRY_DSN**: In Sentry, go to your project → Settings → Client Keys (DSN)

2. **SENTRY_AUTH_TOKEN**: Create at https://sentry.io/settings/auth-tokens/
   - Required scopes: `project:releases`, `org:read`

3. **SENTRY_ORG**: Your organization slug from your Sentry URL (e.g., `my-org` from `sentry.io/organizations/my-org/`)

4. **SENTRY_PROJECT**: Your project slug from Settings → General Settings

#### Local Development

For local release builds with Sentry enabled, set environment variables:

```bash
export SENTRY_DSN="https://your-key@your-org.ingest.sentry.io/project-id"
export SENTRY_AUTH_TOKEN="your-auth-token"
export SENTRY_ORG="your-org"
export SENTRY_PROJECT="your-project"
```

#### CI/CD Integration (GitHub Actions)

Add these as repository secrets in GitHub (Settings → Secrets and variables → Actions):

- `SENTRY_DSN`
- `SENTRY_AUTH_TOKEN`
- `SENTRY_ORG`
- `SENTRY_PROJECT`

Then reference them in your workflow:

```yaml
env:
  SENTRY_DSN: ${{ secrets.SENTRY_DSN }}
  SENTRY_AUTH_TOKEN: ${{ secrets.SENTRY_AUTH_TOKEN }}
  SENTRY_ORG: ${{ secrets.SENTRY_ORG }}
  SENTRY_PROJECT: ${{ secrets.SENTRY_PROJECT }}
```

### Runtime Behavior

- **Debug builds**: Sentry is disabled (`options.isEnabled = false`)
- **Release builds without DSN**: Sentry initialization is skipped
- **Release builds with DSN**: Full crash reporting and performance monitoring

### Customization

Sentry configuration is in `app/build.gradle.kts` (Gradle plugin) and `LionReaderApp.kt` (runtime options). Key settings:

```kotlin
// In LionReaderApp.kt
options.tracesSampleRate = 1.0  // 100% of transactions (adjust for high-traffic apps)
options.isEnableAutoSessionTracking = true
options.environment = if (BuildConfig.DEBUG) "development" else "production"
```

## Play Store Listing

### Required Assets

Before submitting to the Google Play Store, prepare the following:

#### App Icon

- **Size**: 512x512 px
- **Format**: PNG (32-bit, with alpha)
- **Notes**: Used in Play Store listing and search results

#### Feature Graphic

- **Size**: 1024x500 px
- **Format**: PNG or JPEG
- **Notes**: Displayed at top of Play Store listing

#### Screenshots

- **Phone**: At least 2 screenshots (320-3840 px, 16:9 or 9:16)
- **7-inch tablet**: At least 1 screenshot (optional but recommended)
- **10-inch tablet**: At least 1 screenshot (optional but recommended)
- **Format**: PNG or JPEG (24-bit, no alpha)

#### Store Listing Text

- **Title**: Up to 30 characters
- **Short description**: Up to 80 characters
- **Full description**: Up to 4000 characters

#### Content Rating

Complete the content rating questionnaire in Play Console.

#### Privacy Policy

Required URL to privacy policy hosted online.

### Asset Location

Create assets in a directory outside the source code:

```
play-store-assets/
├── icon/
│   └── icon-512x512.png
├── feature-graphic/
│   └── feature-1024x500.png
├── screenshots/
│   ├── phone/
│   │   ├── screenshot-1.png
│   │   └── screenshot-2.png
│   └── tablet/
│       └── screenshot-1.png
└── listing/
    ├── title.txt
    ├── short-description.txt
    └── full-description.txt
```

## Architecture

### Tech Stack

- **Language**: Kotlin 2.0
- **UI**: Jetpack Compose with Material 3
- **Architecture**: MVVM with Clean Architecture principles
- **Dependency Injection**: Hilt
- **Networking**: Ktor Client
- **Local Storage**: Room Database
- **Preferences**: DataStore
- **Background Work**: WorkManager
- **Image Loading**: Coil

### Key Components

- **Data Layer**: Repositories, API clients, Room database
- **Domain Layer**: Business logic, data transformations
- **UI Layer**: Compose screens, ViewModels, UI state

### Offline Support

The app supports offline-first architecture:

- Entries are cached in Room database
- Sync operations run via WorkManager
- Pending actions queue for offline changes
- Automatic sync when connectivity is restored

## Troubleshooting

### Build Errors

**Error: "SDK location not found"**

- Ensure `local.properties` contains correct `sdk.dir` path
- Or set `ANDROID_HOME` environment variable

**Error: Release signing not configured**

- Configure keystore as described in [Keystore Setup](#keystore-setup)
- Debug builds don't require keystore configuration

**ProGuard/R8 issues in release builds**

- Check `proguard-rules.pro` for missing keep rules
- Run with `--info` flag for detailed shrinking logs:
  ```bash
  ./gradlew assembleRelease --info
  ```

### Testing Issues

**Instrumented tests failing**

- Ensure emulator or device is connected and detected
- Check Android SDK platform tools are up to date
- Try `adb kill-server && adb start-server`

## License

[Add license information here]

## Contributing

[Add contribution guidelines here]
