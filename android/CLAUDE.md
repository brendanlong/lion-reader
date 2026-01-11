# Android App Development Guidelines

## Documentation

See [README.md](README.md) for setup, build instructions, and architecture overview.

## Code Quality

Before committing, run:

```bash
./gradlew check  # Runs ktlint, detekt, and tests
```

Or run individual checks:

```bash
./gradlew ktlintCheck     # Code style
./gradlew ktlintFormat    # Auto-fix style issues
./gradlew detekt          # Static analysis
./gradlew test            # Unit tests
```

## API Contract Testing

When adding new API endpoints to `LionReaderApiImpl`, also add them to `clientPaths` in `ApiContractTest`. This test validates that all client API paths exist in the server's OpenAPI spec, catching mismatches before they cause runtime 404 errors.

Example - if you add a new endpoint in `LionReaderApiImpl.kt`:

```kotlin
suspend fun getNewThing(): NewThing {
    return httpClient.get("new-thing").body()
}
```

Add the corresponding entry in `ApiContractTest.kt`:

```kotlin
private val clientPaths = listOf(
    // ... existing paths ...
    PathWithMethod("GET", "new-thing"),
)
```

Run the contract test:

```bash
./gradlew testDebugUnitTest --tests "*.ApiContractTest"
```

## Architecture

The app follows Clean Architecture with MVVM:

- **data/** - API clients, Room database, repositories
- **di/** - Hilt dependency injection modules
- **service/** - Background services (sync, etc.)
- **ui/** - Compose screens, ViewModels, UI state

### Key Patterns

- **Offline-first**: Data flows through Room database; sync via WorkManager
- **Pending actions**: Offline changes are queued and synced when connectivity returns
- **Unidirectional data flow**: ViewModels expose StateFlow, UI observes and sends events

## Testing

### Unit Tests (`src/test/`)

- Pure business logic, no Android framework dependencies
- Run fast, no emulator needed
- Test ViewModels, repositories, data transformations

### Instrumented Tests (`src/androidTest/`)

- Tests that need Android framework (Room DAOs, UI tests)
- Require emulator or device
- Use Hilt testing utilities for DI

## Conventions

### Kotlin

- Use data classes for DTOs and state objects
- Prefer `sealed class` for representing finite states
- Use `@Serializable` (kotlinx.serialization) for API models

### Compose

- State hoisting: UI components receive state, emit events
- Use `remember` and `derivedStateOf` appropriately
- Preview functions for all reusable components

### Coroutines

- ViewModels use `viewModelScope`
- Repositories expose `Flow` for reactive data
- Use `Dispatchers.IO` for blocking operations
