# Lion Reader Android App Implementation Checklist

Each task below is designed to be a self-contained PR. Complete them in order.

ALWAYS read @docs/android-app-design.md before starting.

## Configuration

- **Production API URL**: `https://lionreader.com`
- **API Base Path**: `/api/v1`

---

## Phase 1: Project Setup

### 1.1 Project Scaffolding

- [ ] **Initialize Android project with Kotlin and Compose**
  - Create new Android project with Android Studio
  - Configure Kotlin 1.9+ and Compose compiler
  - Set minSdk 26, targetSdk 34
  - Configure Gradle with Kotlin DSL (build.gradle.kts)
  - Set up module structure (app module only for now)
  - Add .gitignore for Android
  - Configure ktlint and detekt for code quality
  - Set up pre-commit hooks

### 1.2 Dependency Injection

- [ ] **Configure Hilt for dependency injection**
  - Add Hilt dependencies (hilt-android, hilt-compiler)
  - Create @HiltAndroidApp Application class
  - Set up base Hilt modules structure (AppModule, DatabaseModule, NetworkModule)
  - Verify Hilt is working with a simple @Inject test
  - Document Hilt usage patterns in README

### 1.3 Core Dependencies

- [ ] **Add core library dependencies**
  - Add Kotlin Coroutines (core, android)
  - Add Kotlin Serialization
  - Add Compose dependencies (ui, material3, navigation)
  - Add Lifecycle components (viewmodel, runtime-compose)
  - Add Room (runtime, ktx, compiler)
  - Add Ktor Client (core, cio, content-negotiation, serialization)
  - Add DataStore for preferences
  - Add Coil for image loading
  - Verify all dependencies resolve correctly

---

## Phase 2: Data Layer

### 2.1 Room Database Setup

- [ ] **Create Room database and core entities**
  - Create LionReaderDatabase class
  - Create SessionEntity (token, userId, email, createdAt)
  - Create FeedEntity (id, type, url, title, description, siteUrl)
  - Create SubscriptionEntity (id, feedId, customTitle, subscribedAt, unreadCount)
  - Add database version and migrations infrastructure
  - Write unit tests for entity creation

### 2.2 Entry Entities

- [ ] **Add entry-related entities**
  - Create EntryEntity (id, feedId, url, title, author, summary, content, dates)
  - Create EntryStateEntity (entryId, read, starred, timestamps, pendingSync)
  - Create EntryWithState data class with relationship
  - Add indexes for common queries (feedId, fetchedAt)
  - Write unit tests

### 2.3 Tags and Junction Tables

- [ ] **Add tag-related entities**
  - Create TagEntity (id, name, color, feedCount)
  - Create SubscriptionTagEntity junction table
  - Create SubscriptionWithFeed data class
  - Create SubscriptionWithTags data class
  - Write unit tests

### 2.4 Offline Sync Entities

- [ ] **Add entities for offline sync tracking**
  - Create PendingActionEntity (id, type, entryId, createdAt, retryCount)
  - Action types: mark_read, mark_unread, star, unstar
  - Add auto-incrementing ID for ordering
  - Write unit tests

### 2.5 Entry DAO

- [ ] **Implement Entry DAO**
  - Create EntryDao interface
  - getEntries() with filters (feedId, tagId, unreadOnly, starredOnly, sortOrder)
  - getEntry(id) for single entry
  - insertEntries() for bulk insert
  - deleteEntriesForFeed() for cleanup
  - Use Flow for reactive queries
  - Write integration tests with in-memory database

### 2.6 Entry State DAO

- [ ] **Implement Entry State DAO**
  - Create EntryStateDao interface
  - getState(entryId) for single state
  - upsertState() for insert/update
  - markRead() with pendingSync flag
  - setStarred() with pendingSync flag
  - getPendingSyncEntryIds() for sync
  - clearPendingSync() after successful sync
  - Write integration tests

### 2.7 Pending Action DAO

- [ ] **Implement Pending Action DAO**
  - Create PendingActionDao interface
  - insert() for new actions
  - getAllPending() ordered by createdAt
  - delete() for completed actions
  - incrementRetry() for failed attempts
  - deleteFailedActions() for cleanup (retryCount > 5)
  - Write integration tests

### 2.8 Subscription and Tag DAOs

- [ ] **Implement Subscription and Tag DAOs**
  - Create SubscriptionDao with getAllWithFeeds() as Flow
  - insertAll() and insertFeeds() for bulk operations
  - Create TagDao with getAll() as Flow
  - getTagsForSubscription() for junction queries
  - insertAll() and insertSubscriptionTags()
  - Write integration tests

---

## Phase 3: API Client

### 3.1 Ktor Client Setup

- [ ] **Configure Ktor HTTP client**
  - Create HttpClient with CIO engine
  - Configure JSON serialization with kotlinx.serialization
  - Set up content negotiation
  - Configure timeouts (connect: 10s, request: 30s)
  - Add logging interceptor for debug builds
  - Create NetworkModule Hilt binding

### 3.2 Auth Interceptor

- [ ] **Implement authentication interceptor**
  - Create SessionStore for secure token storage
  - Use EncryptedSharedPreferences for token security
  - Create AuthInterceptor that adds Bearer token header
  - Handle missing token gracefully
  - Write unit tests

### 3.3 API Response Types

- [ ] **Define API response data classes**
  - Create User, LoginResponse, UserResponse DTOs
  - Create FeedDto, SubscriptionDto, SubscriptionsResponse
  - Create TagDto, TagsResponse
  - Create EntryDto, EntriesResponse, EntryResponse
  - Create NarrationResponse for V2
  - Create ErrorResponse for error handling
  - Add kotlinx.serialization annotations

### 3.4 API Interface - Auth

- [ ] **Implement auth API endpoints**
  - Create LionReaderApi interface
  - login(email, password) → LoginResponse
  - getAuthProviders() → ProvidersResponse
  - googleAuthUrl() → AuthUrlResponse
  - googleCallback(code, state) → LoginResponse
  - appleCallback(code, state, user) → LoginResponse
  - me() → UserResponse
  - logout()
  - Write unit tests with mock server

### 3.5 API Interface - Data

- [ ] **Implement data API endpoints**
  - listSubscriptions() → SubscriptionsResponse
  - listTags() → TagsResponse
  - listEntries(filters) → EntriesResponse
  - getEntry(id) → EntryResponse
  - markRead(ids, read)
  - star(id), unstar(id)
  - Write unit tests with mock server

### 3.6 Error Handling

- [ ] **Implement API error handling**
  - Create ApiResult<T> sealed class (Success, Error, NetworkError, Unauthorized)
  - Parse error responses into ApiResult.Error
  - Handle network exceptions → NetworkError
  - Handle 401 → Unauthorized (trigger logout)
  - Handle rate limiting (429) with Retry-After
  - Create extension functions for common error handling
  - Write unit tests

---

## Phase 4: Repositories

### 4.1 Auth Repository

- [ ] **Implement AuthRepository**
  - Inject API client and SessionStore
  - login() - call API, store session, return result
  - logout() - call API, clear session
  - isLoggedIn() - check SessionStore
  - getCurrentUser() - call me() endpoint
  - Expose isLoggedIn as StateFlow
  - Write unit tests

### 4.2 Subscription Repository

- [ ] **Implement SubscriptionRepository**
  - Inject API client, SubscriptionDao
  - getSubscriptions() - return Flow from local DB
  - syncSubscriptions() - fetch from API, update local DB
  - Map API DTOs to entities
  - Write unit tests

### 4.3 Tag Repository

- [ ] **Implement TagRepository**
  - Inject API client, TagDao
  - getTags() - return Flow from local DB
  - syncTags() - fetch from API, update local DB
  - Write unit tests

### 4.4 Entry Repository - Read Operations

- [ ] **Implement EntryRepository read operations**
  - Inject API client, EntryDao, EntryStateDao
  - getEntries(filters) - return Flow from local DB
  - getEntry(id) - return from local DB, fetch if missing
  - syncEntries(filters) - fetch from API with pagination, update local
  - Handle cursor-based pagination
  - Write unit tests

### 4.5 Entry Repository - Write Operations

- [ ] **Implement EntryRepository write operations with offline support**
  - markRead(entryId, read) - update local immediately, queue sync
  - setStarred(entryId, starred) - update local immediately, queue sync
  - Inject PendingActionDao for sync queue
  - Call syncPendingActions() if online
  - Write unit tests

### 4.6 Sync Repository

- [ ] **Implement SyncRepository for pending action sync**
  - syncPendingActions() - process all pending actions
  - Batch mark_read/mark_unread actions for bulk API call
  - Process star/unstar one at a time
  - Handle errors with retry count increment
  - Clear pendingSync flags on success
  - Delete failed actions after max retries
  - Write unit tests

---

## Phase 5: Connectivity & Background Sync

### 5.1 Connectivity Monitor

- [ ] **Implement ConnectivityMonitor**
  - Create ConnectivityMonitor class
  - Register NetworkCallback with ConnectivityManager
  - Expose isOnline as StateFlow<Boolean>
  - Trigger sync when connectivity restored
  - Handle callback lifecycle properly
  - Write unit tests

### 5.2 Sync Worker

- [ ] **Implement background SyncWorker**
  - Create SyncWorker extending CoroutineWorker
  - Inject repositories via HiltWorker
  - Call syncPendingActions() then syncFromServer()
  - Return Result.success/retry/failure appropriately
  - Configure retry with exponential backoff
  - Write unit tests

### 5.3 Sync Scheduler

- [ ] **Implement SyncScheduler with WorkManager**
  - Create SyncScheduler singleton
  - schedulePeriodicSync() - every 15 minutes with network constraint
  - triggerImmediateSync() - one-time sync request
  - Use ExistingPeriodicWorkPolicy.KEEP for periodic
  - Integrate with ConnectivityMonitor for connectivity-triggered sync
  - Write integration tests

### 5.4 Full Sync Flow

- [ ] **Implement complete sync flow**
  - syncFromServer() in EntryRepository
  - First push pending changes
  - Fetch subscriptions (includes unread counts)
  - Fetch tags
  - Fetch entries with pagination
  - Update local entry states from server
  - Handle conflicts (server wins for non-pending items)
  - Write integration tests

---

## Phase 6: Authentication UI

### 6.1 Login Screen UI

- [ ] **Create LoginScreen composable**
  - Build centered layout with logo
  - Email text field with keyboard type
  - Password text field with visibility toggle
  - Sign In button with loading state
  - Error message display
  - Divider with "or continue with" text
  - Apply Material 3 theming
  - Write UI tests

### 6.2 Login ViewModel

- [ ] **Implement LoginViewModel**
  - Inject AuthRepository
  - Expose LoginUiState (email, password, isLoading, error)
  - onEmailChange(), onPasswordChange() handlers
  - login() function with error handling
  - Clear error on input change
  - Write unit tests

### 6.3 Auth Navigation

- [ ] **Implement auth-aware navigation**
  - Check isLoggedIn on app start
  - Navigate to login if not authenticated
  - Navigate to main screen if authenticated
  - Handle 401 responses → logout and redirect
  - Write navigation tests

---

## Phase 7: Core Navigation

### 7.1 Navigation Setup

- [ ] **Configure Compose Navigation**
  - Add navigation-compose dependency
  - Create NavGraph with auth and main destinations
  - Create Screen sealed class for type-safe navigation
  - Set up NavHost in MainActivity
  - Write navigation tests

### 7.2 Main Scaffold

- [ ] **Create main app scaffold**
  - ModalNavigationDrawer with drawer content
  - Scaffold with TopAppBar
  - Handle drawer open/close state
  - Apply Material 3 theming
  - Write UI tests

### 7.3 Navigation Drawer

- [ ] **Implement navigation drawer**
  - Drawer header with app name/logo
  - "All" navigation item
  - "Starred" navigation item
  - Divider
  - Tags section with colored indicators
  - Feeds section with unread counts
  - Sign Out item at bottom
  - Handle item selection and navigation
  - Write UI tests

### 7.4 Drawer ViewModel

- [ ] **Implement DrawerViewModel**
  - Inject SubscriptionRepository, TagRepository, AuthRepository
  - Expose subscriptions as StateFlow
  - Expose tags as StateFlow
  - signOut() function
  - Write unit tests

---

## Phase 8: Entry List

### 8.1 Entry List Screen

- [ ] **Create EntryListScreen composable**
  - TopAppBar with title, menu icon, filter actions
  - Offline indicator when !isOnline
  - Unread toggle button
  - Sort order toggle button
  - LazyColumn for entry items
  - Loading, empty, and error states
  - Write UI tests

### 8.2 Entry List Item

- [ ] **Create EntryListItem composable**
  - Card with feed title, entry title, summary
  - Read/unread indicator (opacity, dot)
  - Star indicator
  - Relative timestamp
  - Swipe actions for read/star (optional)
  - Click handler for navigation
  - Write UI tests

### 8.3 Entry List ViewModel

- [ ] **Implement EntryListViewModel**
  - Accept filter parameters via SavedStateHandle
  - Inject EntryRepository, ConnectivityMonitor
  - Expose entries as StateFlow (from local DB)
  - Expose uiState (title, unreadOnly, sortOrder, hasMore, isLoading)
  - toggleUnreadOnly(), toggleSortOrder()
  - toggleRead(entryId), toggleStar(entryId)
  - loadMore() for pagination
  - Write unit tests

### 8.4 Pull-to-Refresh

- [ ] **Add pull-to-refresh to entry list**
  - Add pullRefresh modifier
  - Show refresh indicator
  - Call sync on refresh
  - Handle offline gracefully
  - Write UI tests

### 8.5 Infinite Scroll

- [ ] **Implement infinite scroll pagination**
  - Detect when near end of list
  - Trigger loadMore() automatically
  - Show loading indicator at bottom
  - Handle hasMore flag
  - Prevent duplicate loads
  - Write UI tests

---

## Phase 9: Entry Detail

### 9.1 Entry Detail Screen

- [ ] **Create EntryDetailScreen composable**
  - TopAppBar with back button, star, share, open in browser
  - ScrollableColumn for content
  - Feed name, title, author, date header
  - HTML content (WebView or custom renderer)
  - Loading state
  - Write UI tests

### 9.2 Entry Detail ViewModel

- [ ] **Implement EntryDetailViewModel**
  - Accept entryId via SavedStateHandle
  - Inject EntryRepository
  - loadEntry(id) - fetch from local, API if needed
  - Expose entry as StateFlow
  - markAsRead() - called on view
  - toggleStar()
  - share(url), openInBrowser(url)
  - Write unit tests

### 9.3 HTML Content Rendering

- [ ] **Implement HTML content display**
  - Create HtmlContent composable
  - Use AndroidView with WebView
  - Style content with CSS (fonts, colors, spacing)
  - Handle images with max-width
  - Handle links (open in browser)
  - Disable JavaScript for security
  - Handle dark mode styling
  - Write UI tests

### 9.4 Share and Open Actions

- [ ] **Implement share and open in browser**
  - Create share intent with article URL and title
  - Create browser intent with article URL
  - Handle missing URL gracefully
  - Add share and browser icons to TopAppBar
  - Write unit tests

---

## Phase 10: Theming and Polish

### 10.1 Material 3 Theme

- [ ] **Configure Material 3 theme**
  - Define color scheme (primary, secondary, tertiary)
  - Support light and dark mode
  - Define typography scale
  - Apply theme in app theme wrapper
  - Test on different Android versions

### 10.2 Loading States

- [ ] **Add loading skeletons and states**
  - Create shimmer loading effect composable
  - Entry list loading skeleton
  - Entry detail loading skeleton
  - Drawer loading skeleton
  - Apply consistently across screens

### 10.3 Error States

- [ ] **Add error handling UI**
  - Create ErrorState composable with retry button
  - Handle network errors
  - Handle API errors
  - Toast for transient errors
  - Full-screen error for critical failures

### 10.4 Empty States

- [ ] **Add empty state UI**
  - EmptyState composable with icon and message
  - "No entries" state for empty list
  - "All caught up!" for unread-only with no unread
  - "No feeds" state for new users
  - Contextual messaging per screen

### 10.5 Offline Indicator

- [ ] **Add offline mode indicator**
  - Show icon in TopAppBar when offline
  - Show banner or snackbar on connectivity loss
  - Show toast when connectivity restored
  - Trigger sync on reconnection
  - Write UI tests

---

## Phase 11: Testing and Quality

### 11.1 Unit Test Suite

- [ ] **Complete unit test coverage**
  - Test all ViewModels
  - Test all Repositories
  - Test API client with mock server
  - Test Room DAOs with in-memory database
  - Aim for 80%+ coverage on business logic

### 11.2 UI Test Suite

- [ ] **Create UI test suite**
  - Test login flow
  - Test navigation
  - Test entry list interactions
  - Test entry detail view
  - Use Compose testing APIs

### 11.3 Integration Tests

- [ ] **Create integration tests**
  - Test full sync flow
  - Test offline/online transitions
  - Test auth flow end-to-end
  - Use Hilt test runner

### 11.4 CI Pipeline

- [ ] **Set up GitHub Actions CI**
  - Run unit tests on PR
  - Run lint (ktlint, detekt)
  - Run UI tests with emulator
  - Cache Gradle dependencies
  - Build APK artifact

---

## Phase 12: Release Preparation

### 12.1 App Signing

- [ ] **Configure app signing**
  - Generate release keystore
  - Configure signing in build.gradle.kts
  - Set up secrets for CI/CD
  - Document keystore backup procedure

### 12.2 ProGuard/R8

- [ ] **Configure code shrinking**
  - Enable R8 for release builds
  - Add ProGuard rules for Ktor, Room, kotlinx.serialization
  - Test release build thoroughly
  - Verify obfuscation doesn't break functionality

### 12.3 Build Variants

- [ ] **Configure build variants**
  - Debug variant with logging, debug API URL
  - Release variant with production URL, no logging
  - Configure applicationIdSuffix for debug
  - Add version code/name management

### 12.4 Play Store Listing

- [ ] **Prepare Play Store assets**
  - App icon (512x512)
  - Feature graphic (1024x500)
  - Screenshots for phone and tablet
  - Short and full description
  - Privacy policy URL
  - Document release process

---

## Phase 13: V2 - Audio Narration

### 13.1 Narration Repository

- [ ] **Implement NarrationRepository**
  - Create NarrationEntity for local caching
  - Create NarrationDao
  - getNarration(entryId) - check cache first
  - Fetch from API if not cached
  - Store result in local DB
  - Write unit tests

### 13.2 Narration API

- [ ] **Add narration API endpoint**
  - generateNarration(type, id) → NarrationResponse
  - Handle "entry" and "saved" types
  - Return narration text, cached flag, source
  - Handle errors (show fallback option)
  - Write unit tests

### 13.3 TTS Setup

- [ ] **Configure Android TextToSpeech**
  - Initialize TextToSpeech in service
  - Handle initialization callback
  - Set language (Locale.US default)
  - Configure voice selection
  - Handle TTS unavailable gracefully
  - Write unit tests

### 13.4 Narration Service

- [ ] **Create NarrationService foreground service**
  - Extend Service, implement foreground service
  - Initialize TTS and MediaSession
  - startNarration(entry, text) - start playback
  - Split text into paragraphs
  - Play paragraphs sequentially
  - Handle utterance completion
  - Write unit tests

### 13.5 Playback Controls

- [ ] **Implement playback control methods**
  - playCurrentParagraph()
  - pausePlayback()
  - resumePlayback()
  - stopPlayback()
  - skipToNextParagraph()
  - skipToPreviousParagraph()
  - Track current paragraph index
  - Write unit tests

### 13.6 MediaSession Integration

- [ ] **Implement MediaSession for system controls**
  - Create MediaSessionCompat
  - Set MediaSessionCallback for play/pause/skip
  - Update playback state on changes
  - Set MediaMetadata (title, artist/feed)
  - Handle Bluetooth media buttons
  - Write integration tests

### 13.7 Notification Controls

- [ ] **Create media notification**
  - Create notification channel
  - Build notification with MediaStyle
  - Add play/pause, skip prev/next actions
  - Update notification on state changes
  - Handle notification actions via PendingIntent
  - Write UI tests

### 13.8 Narration ViewModel

- [ ] **Implement NarrationViewModel**
  - Inject NarrationRepository, service binding
  - play(entry) - fetch narration, start service
  - pause(), resume(), stop()
  - skipNext(), skipPrevious()
  - Expose NarrationState as StateFlow
  - Handle loading, playing, paused, error states
  - Write unit tests

### 13.9 Narration UI Controls

- [ ] **Add narration controls to entry detail**
  - Create NarrationControls composable
  - Play button (idle state)
  - Loading indicator (loading state)
  - Play/pause + skip buttons (playing/paused)
  - Progress indicator (current/total paragraphs)
  - Error state with retry
  - Add to EntryDetailScreen bottom bar
  - Write UI tests

### 13.10 Narration Progress Broadcast

- [ ] **Broadcast playback progress for UI**
  - Send LocalBroadcast with paragraph index
  - Create BroadcastReceiver in ViewModel
  - Update UI with current paragraph
  - Optionally highlight current paragraph in content
  - Write integration tests

### 13.11 Audio Focus

- [ ] **Handle audio focus properly**
  - Request audio focus before playback
  - Handle focus loss (pause playback)
  - Handle transient focus loss (duck or pause)
  - Release focus on stop
  - Write integration tests

### 13.12 Service Lifecycle

- [ ] **Handle service lifecycle correctly**
  - Start as foreground service immediately
  - Stop foreground and service when done
  - Handle app kill (save state, resume)
  - Handle incoming calls (pause)
  - Write integration tests

---

## Phase 14: V2 Polish

### 14.1 Narration Settings

- [ ] **Add narration settings UI**
  - Speed slider (0.5x - 2.0x)
  - Pitch slider (0.5x - 2.0x)
  - Voice selector (from available voices)
  - Preview button for voice
  - Store settings in DataStore
  - Apply settings to TTS
  - Write UI tests

### 14.2 Background Playback

- [ ] **Verify background playback works**
  - Test playback continues when app backgrounded
  - Test playback continues with screen off
  - Test notification controls work
  - Test lock screen controls work
  - Test Bluetooth controls work
  - Document any limitations

### 14.3 Error Recovery

- [ ] **Handle narration errors gracefully**
  - Handle API errors (show fallback option)
  - Handle TTS initialization failure
  - Handle utterance errors
  - Retry logic for transient failures
  - Clear error state on retry
  - Write integration tests

### 14.4 Metrics (Optional)

- [ ] **Add analytics for narration**
  - Track narration started count
  - Track narration completed count
  - Track average listen duration
  - Track skip actions
  - Use Firebase Analytics or similar

---

## Phase 15: OAuth Authentication

### 15.1 OAuth Buttons

- [ ] **Add OAuth sign-in buttons to login screen**
  - Fetch providers from auth.providers endpoint
  - Show Google button if "google" in providers
  - Show Apple button if "apple" in providers
  - Style buttons appropriately (Google colors, Apple black/white)
  - loginWithGoogle(), loginWithApple() in ViewModel
  - Write unit tests

### 15.2 Google OAuth Flow

- [ ] **Implement Google OAuth flow**
  - Create GoogleAuthManager class
  - startAuth() - get auth URL, store state, return Custom Tab intent
  - handleCallback(uri) - verify state, exchange code, store session
  - Use Chrome Custom Tabs for OAuth
  - Handle errors gracefully
  - Write integration tests

### 15.3 Apple OAuth Flow

- [ ] **Implement Apple OAuth flow**
  - Create AppleAuthManager class (similar to Google)
  - Handle Apple's user info on first auth
  - Support AppleUser object parsing
  - Write integration tests

### 15.4 Deep Link Handling

- [ ] **Configure OAuth callback deep links**
  - Add intent-filter for lionreader://oauth/callback
  - Handle deep link in MainActivity
  - Route to appropriate auth manager
  - Handle errors and show toast
  - Write integration tests

### 15.5 Server-Side Mobile OAuth Support

- [ ] **Add mobile redirect support to server OAuth callbacks**
  - Detect mobile user-agent or add `?platform=android` param
  - Redirect to `lionreader://oauth/callback?token=...` for mobile
  - Or return JSON response for mobile clients to handle
  - Update both Google and Apple callback routes
  - Write integration tests

---

## Stretch Goals (Post-MVP)

### S1 Widgets

- [ ] **Create home screen widget**
  - Show unread count
  - Show latest entry titles
  - Tap to open app
  - Refresh button

### S2 Wear OS

- [ ] **Create Wear OS companion app**
  - Show unread entries
  - Mark read from watch
  - Narration controls on watch

### S3 Tablet Layout

- [ ] **Optimize for tablets**
  - Master-detail layout on large screens
  - Sidebar always visible
  - Responsive breakpoints

### S4 Offline Voice Caching

- [ ] **Cache narration audio for offline**
  - Generate audio on fetch
  - Store in local files
  - Play cached audio when offline
  - Manage cache size

---

## Notes

### PR Size Guidelines

- Each task should be completable in 1-3 days
- PRs should be < 500 lines of code when possible
- Split large features into smaller incremental PRs
- Each PR should leave the app in a working state

### Testing Requirements

- Unit tests required for all ViewModels and Repositories
- UI tests required for critical user flows
- Integration tests for sync and auth flows

### Code Quality

- All code must pass ktlint and detekt
- No warnings in release build
- Document public APIs
- Follow Kotlin coding conventions
