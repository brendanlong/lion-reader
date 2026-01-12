# Android App Development Guidelines

See [README.md](README.md) for setup and build instructions.

## Commands

```bash
./gradlew check          # Runs ktlint, detekt, and tests
./gradlew ktlintFormat   # Auto-fix style issues
./gradlew detekt         # Static analysis
./gradlew test           # Unit tests
```

## Project Structure

```
data/           # API clients, Room database, repositories
di/             # Hilt dependency injection modules
service/        # Background services (sync)
ui/             # Compose screens, ViewModels, UI state
src/test/       # Unit tests (no Android framework)
src/androidTest/ # Instrumented tests (Room DAOs, UI)
```

## Conventions

- Use `data class` for DTOs and state objects
- Use `sealed class` for finite states
- Use `@Serializable` (kotlinx.serialization) for API models

## Key Patterns

- **Offline-first**: Data flows through Room; sync via WorkManager
- **Pending actions**: Offline changes queued and synced when connectivity returns

## API Contract Testing

When adding endpoints to `LionReaderApiImpl`, add them to `clientPaths` in `ApiContractTest`:

```kotlin
// In LionReaderApiImpl.kt
suspend fun getNewThing(): NewThing = httpClient.get("new-thing").body()

// In ApiContractTest.kt
private val clientPaths = listOf(
    // ...
    PathWithMethod("GET", "new-thing"),
)
```

Run: `./gradlew testDebugUnitTest --tests "*.ApiContractTest"`
