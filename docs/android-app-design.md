# Lion Reader Android App Design

## Overview

Native Android app for Lion Reader using modern Kotlin/Jetpack Compose. The app prioritizes offline-first reading with automatic sync when connectivity returns.

## Table of Contents

1. [MVP Scope](#mvp-scope)
2. [Architecture](#architecture)
3. [Data Layer](#data-layer)
4. [API Client](#api-client)
5. [Offline & Sync](#offline--sync)
6. [UI Design](#ui-design)
7. [Authentication](#authentication)
8. [V2: Audio Narration](#v2-audio-narration)
9. [Technology Stack](#technology-stack)
10. [Project Structure](#project-structure)

---

## MVP Scope

### Included

- **Sign-in**: Email/password and OAuth (Google, Apple)
- **View entries**: All, starred, by feed, by tag
- **Entry actions**: Mark read/unread, star/unstar
- **Offline reading**: Full content cached locally
- **Background sync**: Track read state offline, sync when online

### Excluded (Future)

- Sign-up / account creation
- Tag management (create/edit/delete tags)
- Subscription management (add/remove feeds)
- Settings / preferences
- Search

---

## Architecture

### Clean Architecture with MVVM

```
┌─────────────────────────────────────────────────────────────┐
│                         UI Layer                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Screens    │  │ ViewModels  │  │   UI State          │  │
│  │  (Compose)  │◀─│             │◀─│   (StateFlow)       │  │
│  └─────────────┘  └──────┬──────┘  └─────────────────────┘  │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                       Domain Layer                           │
│  ┌─────────────────────────────────────────────────────┐    │
│  │                    Use Cases                         │    │
│  │  GetEntriesUseCase, MarkReadUseCase, SyncUseCase    │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│                       Data Layer                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │  Repository  │──│  Local DB    │  │  Remote API      │   │
│  │              │  │  (Room)      │  │  (Retrofit/Ktor) │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### Key Principles

1. **Offline-first**: Local database is source of truth for UI
2. **Unidirectional data flow**: State flows down, events flow up
3. **Single source of truth**: Repository coordinates local and remote
4. **Background sync**: WorkManager handles periodic sync and connectivity changes

---

## Data Layer

### Room Database Schema

```kotlin
// ============================================================================
// ENTITIES
// ============================================================================

@Entity(tableName = "sessions")
data class SessionEntity(
    @PrimaryKey val token: String,
    val userId: String,
    val email: String,
    val createdAt: Long,
    val expiresAt: Long?
)

@Entity(tableName = "feeds")
data class FeedEntity(
    @PrimaryKey val id: String,
    val type: String,  // "rss", "atom", "json"
    val url: String?,
    val title: String?,
    val description: String?,
    val siteUrl: String?,
    val lastSyncedAt: Long
)

@Entity(tableName = "subscriptions")
data class SubscriptionEntity(
    @PrimaryKey val id: String,
    val feedId: String,
    val customTitle: String?,
    val subscribedAt: Long,
    val unreadCount: Int,
    val lastSyncedAt: Long
)

@Entity(tableName = "tags")
data class TagEntity(
    @PrimaryKey val id: String,
    val name: String,
    val color: String?,  // hex color like "#ff6b6b"
    val feedCount: Int
)

@Entity(
    tableName = "subscription_tags",
    primaryKeys = ["subscriptionId", "tagId"]
)
data class SubscriptionTagEntity(
    val subscriptionId: String,
    val tagId: String
)

@Entity(tableName = "entries")
data class EntryEntity(
    @PrimaryKey val id: String,
    val feedId: String,
    val url: String?,
    val title: String?,
    val author: String?,
    val summary: String?,
    val contentOriginal: String?,
    val contentCleaned: String?,
    val publishedAt: Long?,
    val fetchedAt: Long,
    val feedTitle: String?,
    val lastSyncedAt: Long
)

@Entity(
    tableName = "entry_states",
    primaryKeys = ["entryId"]
)
data class EntryStateEntity(
    val entryId: String,
    val read: Boolean,
    val starred: Boolean,
    val readAt: Long?,
    val starredAt: Long?,
    // Offline sync tracking
    val pendingSync: Boolean = false,
    val lastModifiedAt: Long
)

// ============================================================================
// PENDING ACTIONS (for offline sync)
// ============================================================================

@Entity(tableName = "pending_actions")
data class PendingActionEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val type: String,  // "mark_read", "mark_unread", "star", "unstar"
    val entryId: String,
    val createdAt: Long,
    val retryCount: Int = 0
)
```

### DAOs

```kotlin
@Dao
interface EntryDao {
    // List entries with state (offline-first)
    @Query("""
        SELECT e.*, s.read, s.starred, s.readAt, s.starredAt
        FROM entries e
        LEFT JOIN entry_states s ON e.id = s.entryId
        WHERE (:feedId IS NULL OR e.feedId = :feedId)
          AND (:tagId IS NULL OR e.feedId IN (
              SELECT sub.feedId FROM subscriptions sub
              JOIN subscription_tags st ON sub.id = st.subscriptionId
              WHERE st.tagId = :tagId
          ))
          AND (:unreadOnly = 0 OR COALESCE(s.read, 0) = 0)
          AND (:starredOnly = 0 OR COALESCE(s.starred, 0) = 1)
        ORDER BY
            CASE WHEN :sortOrder = 'newest' THEN e.id END DESC,
            CASE WHEN :sortOrder = 'oldest' THEN e.id END ASC
        LIMIT :limit OFFSET :offset
    """)
    fun getEntries(
        feedId: String?,
        tagId: String?,
        unreadOnly: Boolean,
        starredOnly: Boolean,
        sortOrder: String,
        limit: Int,
        offset: Int
    ): Flow<List<EntryWithState>>

    @Query("SELECT * FROM entries WHERE id = :id")
    suspend fun getEntry(id: String): EntryEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertEntries(entries: List<EntryEntity>)

    @Query("DELETE FROM entries WHERE feedId = :feedId")
    suspend fun deleteEntriesForFeed(feedId: String)
}

@Dao
interface EntryStateDao {
    @Query("SELECT * FROM entry_states WHERE entryId = :entryId")
    suspend fun getState(entryId: String): EntryStateEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertState(state: EntryStateEntity)

    @Query("""
        UPDATE entry_states
        SET read = :read, readAt = :readAt, pendingSync = 1, lastModifiedAt = :modifiedAt
        WHERE entryId = :entryId
    """)
    suspend fun markRead(entryId: String, read: Boolean, readAt: Long?, modifiedAt: Long)

    @Query("""
        UPDATE entry_states
        SET starred = :starred, starredAt = :starredAt, pendingSync = 1, lastModifiedAt = :modifiedAt
        WHERE entryId = :entryId
    """)
    suspend fun setStarred(entryId: String, starred: Boolean, starredAt: Long?, modifiedAt: Long)

    @Query("SELECT entryId FROM entry_states WHERE pendingSync = 1")
    suspend fun getPendingSyncEntryIds(): List<String>

    @Query("UPDATE entry_states SET pendingSync = 0 WHERE entryId IN (:entryIds)")
    suspend fun clearPendingSync(entryIds: List<String>)
}

@Dao
interface PendingActionDao {
    @Insert
    suspend fun insert(action: PendingActionEntity)

    @Query("SELECT * FROM pending_actions ORDER BY createdAt ASC")
    suspend fun getAllPending(): List<PendingActionEntity>

    @Delete
    suspend fun delete(action: PendingActionEntity)

    @Query("UPDATE pending_actions SET retryCount = retryCount + 1 WHERE id = :id")
    suspend fun incrementRetry(id: Long)

    @Query("DELETE FROM pending_actions WHERE retryCount > 5")
    suspend fun deleteFailedActions()
}

@Dao
interface SubscriptionDao {
    @Query("""
        SELECT s.*, f.* FROM subscriptions s
        JOIN feeds f ON s.feedId = f.id
        ORDER BY COALESCE(s.customTitle, f.title) ASC
    """)
    fun getAllWithFeeds(): Flow<List<SubscriptionWithFeed>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(subscriptions: List<SubscriptionEntity>)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertFeeds(feeds: List<FeedEntity>)
}

@Dao
interface TagDao {
    @Query("SELECT * FROM tags ORDER BY name ASC")
    fun getAll(): Flow<List<TagEntity>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(tags: List<TagEntity>)

    @Query("SELECT * FROM subscription_tags WHERE subscriptionId = :subscriptionId")
    suspend fun getTagsForSubscription(subscriptionId: String): List<SubscriptionTagEntity>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertSubscriptionTags(tags: List<SubscriptionTagEntity>)
}
```

### Data Classes (with relationships)

```kotlin
data class EntryWithState(
    @Embedded val entry: EntryEntity,
    val read: Boolean?,
    val starred: Boolean?,
    val readAt: Long?,
    val starredAt: Long?
) {
    val isRead: Boolean get() = read ?: false
    val isStarred: Boolean get() = starred ?: false
}

data class SubscriptionWithFeed(
    @Embedded val subscription: SubscriptionEntity,
    @Embedded(prefix = "feed_") val feed: FeedEntity
) {
    val displayTitle: String get() = subscription.customTitle ?: feed.title ?: "Untitled"
}

data class SubscriptionWithTags(
    val subscription: SubscriptionWithFeed,
    val tags: List<TagEntity>
)
```

---

## API Client

### Retrofit/Ktor Setup

```kotlin
// Using Ktor for modern Kotlin support
interface LionReaderApi {

    // Auth
    suspend fun login(email: String, password: String): LoginResponse
    suspend fun getAuthProviders(): ProvidersResponse
    suspend fun googleAuthUrl(): AuthUrlResponse
    suspend fun googleCallback(code: String, state: String): LoginResponse
    suspend fun appleCallback(code: String, state: String, user: AppleUser?): LoginResponse
    suspend fun me(): UserResponse
    suspend fun logout()

    // Subscriptions
    suspend fun listSubscriptions(): SubscriptionsResponse

    // Tags
    suspend fun listTags(): TagsResponse

    // Entries
    suspend fun listEntries(
        feedId: String? = null,
        tagId: String? = null,
        unreadOnly: Boolean? = null,
        starredOnly: Boolean? = null,
        sortOrder: String? = null,
        cursor: String? = null,
        limit: Int? = null
    ): EntriesResponse

    suspend fun getEntry(id: String): EntryResponse

    suspend fun markRead(ids: List<String>, read: Boolean)

    suspend fun star(id: String)

    suspend fun unstar(id: String)

    // Narration (V2)
    suspend fun generateNarration(type: String, id: String): NarrationResponse
}

// HTTP Client with auth interceptor
class AuthInterceptor(private val sessionStore: SessionStore) {
    fun intercept(request: HttpRequestBuilder) {
        sessionStore.getToken()?.let { token ->
            request.header("Authorization", "Bearer $token")
        }
    }
}

// Response types
data class LoginResponse(
    val user: User,
    val sessionToken: String,
    val isNewUser: Boolean? = null
)

data class EntriesResponse(
    val items: List<EntryDto>,
    val nextCursor: String?
)

data class EntryDto(
    val id: String,
    val feedId: String,
    val url: String?,
    val title: String?,
    val author: String?,
    val summary: String?,
    val contentOriginal: String?,
    val contentCleaned: String?,
    val publishedAt: String?,  // ISO 8601
    val fetchedAt: String,
    val read: Boolean,
    val starred: Boolean,
    val feedTitle: String?,
    val feedUrl: String?
)
```

### Error Handling

```kotlin
sealed class ApiResult<out T> {
    data class Success<T>(val data: T) : ApiResult<T>()
    data class Error(
        val code: String,
        val message: String,
        val details: Map<String, Any>? = null
    ) : ApiResult<Nothing>()
    data object NetworkError : ApiResult<Nothing>()
    data object Unauthorized : ApiResult<Nothing>()
}

// Map API errors
fun parseApiError(response: HttpResponse): ApiResult.Error {
    val body = response.body<ErrorResponse>()
    return ApiResult.Error(
        code = body.error.code,
        message = body.error.message,
        details = body.error.details
    )
}
```

---

## Offline & Sync

### Sync Strategy

```
┌─────────────────────────────────────────────────────────────────┐
│                      Sync Flow                                   │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. App Launch / Resume                                          │
│     └─ Check connectivity                                        │
│        └─ Online: trigger full sync                              │
│        └─ Offline: use cached data                               │
│                                                                  │
│  2. User Action (mark read, star)                                │
│     └─ Update local DB immediately (optimistic)                  │
│     └─ Add to pending_actions table                              │
│     └─ If online: sync immediately                               │
│     └─ If offline: wait for connectivity                         │
│                                                                  │
│  3. Connectivity Restored                                        │
│     └─ WorkManager triggers sync                                 │
│     └─ Process all pending_actions                               │
│     └─ Fetch latest entries                                      │
│     └─ Update local DB with server state                         │
│                                                                  │
│  4. Periodic Background Sync                                     │
│     └─ Every 15 minutes (configurable)                           │
│     └─ Fetch new entries                                         │
│     └─ Update unread counts                                      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Repository Implementation

```kotlin
class EntryRepository(
    private val api: LionReaderApi,
    private val entryDao: EntryDao,
    private val stateDao: EntryStateDao,
    private val pendingActionDao: PendingActionDao,
    private val connectivityMonitor: ConnectivityMonitor
) {
    // Entries as Flow (reactive, offline-first)
    fun getEntries(
        feedId: String? = null,
        tagId: String? = null,
        unreadOnly: Boolean = false,
        starredOnly: Boolean = false,
        sortOrder: SortOrder = SortOrder.NEWEST
    ): Flow<List<EntryWithState>> {
        return entryDao.getEntries(
            feedId = feedId,
            tagId = tagId,
            unreadOnly = unreadOnly,
            starredOnly = starredOnly,
            sortOrder = sortOrder.value,
            limit = 100,
            offset = 0
        )
    }

    // Mark read - optimistic update with sync
    suspend fun markRead(entryId: String, read: Boolean) {
        val now = System.currentTimeMillis()

        // 1. Update local state immediately
        stateDao.markRead(
            entryId = entryId,
            read = read,
            readAt = if (read) now else null,
            modifiedAt = now
        )

        // 2. Queue for sync
        pendingActionDao.insert(
            PendingActionEntity(
                type = if (read) "mark_read" else "mark_unread",
                entryId = entryId,
                createdAt = now
            )
        )

        // 3. Attempt immediate sync if online
        if (connectivityMonitor.isOnline()) {
            syncPendingActions()
        }
    }

    // Star/unstar - same pattern
    suspend fun setStarred(entryId: String, starred: Boolean) {
        val now = System.currentTimeMillis()

        stateDao.setStarred(
            entryId = entryId,
            starred = starred,
            starredAt = if (starred) now else null,
            modifiedAt = now
        )

        pendingActionDao.insert(
            PendingActionEntity(
                type = if (starred) "star" else "unstar",
                entryId = entryId,
                createdAt = now
            )
        )

        if (connectivityMonitor.isOnline()) {
            syncPendingActions()
        }
    }

    // Sync pending actions to server
    suspend fun syncPendingActions() {
        val actions = pendingActionDao.getAllPending()

        // Group mark_read actions for bulk API call
        val readActions = actions.filter { it.type == "mark_read" }
        val unreadActions = actions.filter { it.type == "mark_unread" }

        try {
            // Bulk mark read
            if (readActions.isNotEmpty()) {
                api.markRead(
                    ids = readActions.map { it.entryId },
                    read = true
                )
                readActions.forEach { pendingActionDao.delete(it) }
            }

            // Bulk mark unread
            if (unreadActions.isNotEmpty()) {
                api.markRead(
                    ids = unreadActions.map { it.entryId },
                    read = false
                )
                unreadActions.forEach { pendingActionDao.delete(it) }
            }

            // Star actions (one at a time - API doesn't support bulk)
            actions.filter { it.type == "star" }.forEach { action ->
                api.star(action.entryId)
                pendingActionDao.delete(action)
            }

            // Unstar actions
            actions.filter { it.type == "unstar" }.forEach { action ->
                api.unstar(action.entryId)
                pendingActionDao.delete(action)
            }

            // Clear pending sync flag
            val syncedIds = actions.map { it.entryId }
            stateDao.clearPendingSync(syncedIds)

        } catch (e: Exception) {
            // Increment retry counts, log error
            actions.forEach { pendingActionDao.incrementRetry(it.id) }
            pendingActionDao.deleteFailedActions()  // Remove after 5 retries
        }
    }

    // Full sync from server
    suspend fun syncFromServer() {
        // 1. First, push any pending local changes
        syncPendingActions()

        // 2. Fetch subscriptions (includes unread counts)
        val subscriptions = api.listSubscriptions()
        // Store in DB...

        // 3. Fetch tags
        val tags = api.listTags()
        // Store in DB...

        // 4. Fetch recent entries (paginated)
        var cursor: String? = null
        do {
            val response = api.listEntries(cursor = cursor, limit = 100)
            entryDao.insertEntries(response.items.map { it.toEntity() })

            // Update local state from server
            response.items.forEach { entry ->
                stateDao.upsertState(
                    EntryStateEntity(
                        entryId = entry.id,
                        read = entry.read,
                        starred = entry.starred,
                        readAt = null,
                        starredAt = null,
                        pendingSync = false,
                        lastModifiedAt = System.currentTimeMillis()
                    )
                )
            }

            cursor = response.nextCursor
        } while (cursor != null)
    }
}
```

### WorkManager for Background Sync

```kotlin
class SyncWorker(
    context: Context,
    params: WorkerParameters,
    private val repository: EntryRepository
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        return try {
            repository.syncPendingActions()
            repository.syncFromServer()
            Result.success()
        } catch (e: Exception) {
            if (runAttemptCount < 3) {
                Result.retry()
            } else {
                Result.failure()
            }
        }
    }
}

// Schedule sync work
object SyncScheduler {
    fun schedulePeriodicSync(context: Context) {
        val constraints = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        val syncRequest = PeriodicWorkRequestBuilder<SyncWorker>(
            15, TimeUnit.MINUTES
        )
            .setConstraints(constraints)
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                1, TimeUnit.MINUTES
            )
            .build()

        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(
                "sync",
                ExistingPeriodicWorkPolicy.KEEP,
                syncRequest
            )
    }

    fun triggerImmediateSync(context: Context) {
        val syncRequest = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()
            )
            .build()

        WorkManager.getInstance(context)
            .enqueue(syncRequest)
    }
}

// Connectivity monitor
class ConnectivityMonitor(context: Context) {
    private val connectivityManager =
        context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private val _isOnline = MutableStateFlow(checkConnectivity())
    val isOnline: StateFlow<Boolean> = _isOnline.asStateFlow()

    init {
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                _isOnline.value = true
                // Trigger sync when connectivity restored
                SyncScheduler.triggerImmediateSync(context)
            }

            override fun onLost(network: Network) {
                _isOnline.value = false
            }
        }

        connectivityManager.registerDefaultNetworkCallback(callback)
    }

    fun isOnline(): Boolean = _isOnline.value

    private fun checkConnectivity(): Boolean {
        val network = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}
```

---

## UI Design

### Navigation Structure

```
┌─────────────────────────────────────────────────────────────────┐
│                        App Navigation                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Auth Flow (unauthenticated)                                     │
│  └─ LoginScreen                                                  │
│     ├─ Email/password form                                       │
│     └─ OAuth buttons (Google, Apple)                             │
│                                                                  │
│  Main Flow (authenticated)                                       │
│  ├─ DrawerNavigation                                             │
│  │   ├─ All Entries                                              │
│  │   ├─ Starred                                                  │
│  │   ├─ ─────────────                                            │
│  │   ├─ Tags (expandable)                                        │
│  │   │   ├─ Tag 1                                                │
│  │   │   └─ Tag 2                                                │
│  │   ├─ ─────────────                                            │
│  │   ├─ Feeds (expandable)                                       │
│  │   │   ├─ Feed 1 (unread count)                                │
│  │   │   └─ Feed 2 (unread count)                                │
│  │   └─ ─────────────                                            │
│  │       └─ Sign Out                                             │
│  │                                                               │
│  └─ Screens                                                      │
│      ├─ EntryListScreen (All/Starred/Feed/Tag)                   │
│      └─ EntryDetailScreen                                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Screen Specifications

#### LoginScreen

```kotlin
@Composable
fun LoginScreen(
    viewModel: LoginViewModel = hiltViewModel(),
    onLoginSuccess: () -> Unit
) {
    val uiState by viewModel.uiState.collectAsState()
    val providers by viewModel.providers.collectAsState()

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        // Logo
        Image(
            painter = painterResource(R.drawable.lion_logo),
            contentDescription = "Lion Reader",
            modifier = Modifier.size(120.dp)
        )

        Spacer(modifier = Modifier.height(48.dp))

        // Email field
        OutlinedTextField(
            value = uiState.email,
            onValueChange = viewModel::onEmailChange,
            label = { Text("Email") },
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Email,
                imeAction = ImeAction.Next
            ),
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(16.dp))

        // Password field
        OutlinedTextField(
            value = uiState.password,
            onValueChange = viewModel::onPasswordChange,
            label = { Text("Password") },
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(
                keyboardType = KeyboardType.Password,
                imeAction = ImeAction.Done
            ),
            modifier = Modifier.fillMaxWidth()
        )

        Spacer(modifier = Modifier.height(24.dp))

        // Login button
        Button(
            onClick = viewModel::login,
            enabled = !uiState.isLoading,
            modifier = Modifier.fillMaxWidth()
        ) {
            if (uiState.isLoading) {
                CircularProgressIndicator(modifier = Modifier.size(20.dp))
            } else {
                Text("Sign In")
            }
        }

        // Error message
        uiState.error?.let { error ->
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = error,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall
            )
        }

        Spacer(modifier = Modifier.height(32.dp))

        // OAuth divider
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Divider(modifier = Modifier.weight(1f))
            Text(
                text = "or continue with",
                modifier = Modifier.padding(horizontal = 16.dp),
                style = MaterialTheme.typography.bodySmall
            )
            Divider(modifier = Modifier.weight(1f))
        }

        Spacer(modifier = Modifier.height(24.dp))

        // OAuth buttons
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            if ("google" in providers) {
                OutlinedButton(
                    onClick = viewModel::loginWithGoogle,
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(painterResource(R.drawable.ic_google), "Google")
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Google")
                }
            }

            if ("apple" in providers) {
                OutlinedButton(
                    onClick = viewModel::loginWithApple,
                    modifier = Modifier.weight(1f)
                ) {
                    Icon(painterResource(R.drawable.ic_apple), "Apple")
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Apple")
                }
            }
        }
    }
}
```

#### EntryListScreen

```kotlin
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EntryListScreen(
    viewModel: EntryListViewModel = hiltViewModel(),
    onEntryClick: (String) -> Unit,
    onDrawerOpen: () -> Unit
) {
    val uiState by viewModel.uiState.collectAsState()
    val entries by viewModel.entries.collectAsState()
    val isOnline by viewModel.isOnline.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(uiState.title) },
                navigationIcon = {
                    IconButton(onClick = onDrawerOpen) {
                        Icon(Icons.Default.Menu, "Menu")
                    }
                },
                actions = {
                    // Sync indicator
                    if (!isOnline) {
                        Icon(
                            Icons.Default.CloudOff,
                            contentDescription = "Offline",
                            tint = MaterialTheme.colorScheme.error
                        )
                    }

                    // Filter: show read toggle
                    IconButton(onClick = viewModel::toggleUnreadOnly) {
                        Icon(
                            if (uiState.unreadOnly) Icons.Default.Visibility
                            else Icons.Default.VisibilityOff,
                            contentDescription = "Toggle read items"
                        )
                    }

                    // Sort order toggle
                    IconButton(onClick = viewModel::toggleSortOrder) {
                        Icon(
                            if (uiState.sortOrder == SortOrder.NEWEST)
                                Icons.Default.ArrowDownward
                            else Icons.Default.ArrowUpward,
                            contentDescription = "Sort order"
                        )
                    }
                }
            )
        }
    ) { padding ->
        when {
            uiState.isLoading && entries.isEmpty() -> {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    CircularProgressIndicator()
                }
            }

            entries.isEmpty() -> {
                EmptyState(
                    title = "No entries",
                    message = if (uiState.unreadOnly)
                        "All caught up!"
                    else
                        "No entries in this view"
                )
            }

            else -> {
                LazyColumn(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(padding),
                    contentPadding = PaddingValues(vertical = 8.dp)
                ) {
                    items(
                        items = entries,
                        key = { it.entry.id }
                    ) { entryWithState ->
                        EntryListItem(
                            entry = entryWithState,
                            onClick = { onEntryClick(entryWithState.entry.id) },
                            onToggleRead = {
                                viewModel.toggleRead(
                                    entryWithState.entry.id,
                                    !entryWithState.isRead
                                )
                            },
                            onToggleStar = {
                                viewModel.toggleStar(
                                    entryWithState.entry.id,
                                    !entryWithState.isStarred
                                )
                            }
                        )
                    }

                    // Load more trigger
                    item {
                        if (uiState.hasMore) {
                            LaunchedEffect(Unit) {
                                viewModel.loadMore()
                            }
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(16.dp),
                                contentAlignment = Alignment.Center
                            ) {
                                CircularProgressIndicator()
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
fun EntryListItem(
    entry: EntryWithState,
    onClick: () -> Unit,
    onToggleRead: () -> Unit,
    onToggleStar: () -> Unit
) {
    val alpha = if (entry.isRead) 0.6f else 1f

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 4.dp)
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = if (entry.isRead)
                MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
            else
                MaterialTheme.colorScheme.surface
        )
    ) {
        Column(
            modifier = Modifier.padding(16.dp)
        ) {
            // Feed title
            entry.entry.feedTitle?.let { feedTitle ->
                Text(
                    text = feedTitle,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary.copy(alpha = alpha)
                )
                Spacer(modifier = Modifier.height(4.dp))
            }

            // Entry title
            Text(
                text = entry.entry.title ?: "Untitled",
                style = MaterialTheme.typography.titleMedium,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.alpha(alpha)
            )

            // Summary
            entry.entry.summary?.let { summary ->
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = summary,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha)
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Footer: date + actions
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Date
                Text(
                    text = entry.entry.publishedAt?.let { formatRelativeTime(it) } ?: "",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = alpha)
                )

                // Actions
                Row {
                    IconButton(
                        onClick = onToggleRead,
                        modifier = Modifier.size(32.dp)
                    ) {
                        Icon(
                            if (entry.isRead) Icons.Outlined.Circle
                            else Icons.Filled.Circle,
                            contentDescription = if (entry.isRead) "Mark unread" else "Mark read",
                            modifier = Modifier.size(16.dp),
                            tint = MaterialTheme.colorScheme.primary
                        )
                    }

                    IconButton(
                        onClick = onToggleStar,
                        modifier = Modifier.size(32.dp)
                    ) {
                        Icon(
                            if (entry.isStarred) Icons.Filled.Star
                            else Icons.Outlined.StarBorder,
                            contentDescription = if (entry.isStarred) "Unstar" else "Star",
                            modifier = Modifier.size(16.dp),
                            tint = if (entry.isStarred)
                                MaterialTheme.colorScheme.tertiary
                            else
                                MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        }
    }
}
```

#### EntryDetailScreen

```kotlin
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EntryDetailScreen(
    entryId: String,
    viewModel: EntryDetailViewModel = hiltViewModel(),
    onBack: () -> Unit
) {
    val entry by viewModel.entry.collectAsState()
    val scrollState = rememberScrollState()

    // Mark as read when viewing
    LaunchedEffect(entryId) {
        viewModel.loadEntry(entryId)
        viewModel.markAsRead(entryId)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Default.ArrowBack, "Back")
                    }
                },
                actions = {
                    entry?.let { e ->
                        // Star button
                        IconButton(onClick = { viewModel.toggleStar() }) {
                            Icon(
                                if (e.isStarred) Icons.Filled.Star
                                else Icons.Outlined.StarBorder,
                                contentDescription = "Star"
                            )
                        }

                        // Share button
                        e.entry.url?.let { url ->
                            IconButton(onClick = { viewModel.share(url) }) {
                                Icon(Icons.Default.Share, "Share")
                            }
                        }

                        // Open in browser
                        e.entry.url?.let { url ->
                            IconButton(onClick = { viewModel.openInBrowser(url) }) {
                                Icon(Icons.Default.OpenInBrowser, "Open in browser")
                            }
                        }
                    }
                }
            )
        }
    ) { padding ->
        entry?.let { e ->
            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .verticalScroll(scrollState)
                    .padding(16.dp)
            ) {
                // Feed name
                e.entry.feedTitle?.let { feedTitle ->
                    Text(
                        text = feedTitle,
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                }

                // Title
                Text(
                    text = e.entry.title ?: "Untitled",
                    style = MaterialTheme.typography.headlineMedium
                )

                Spacer(modifier = Modifier.height(8.dp))

                // Meta: author, date
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    e.entry.author?.let { author ->
                        Text(
                            text = author,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }

                    e.entry.publishedAt?.let { date ->
                        Text(
                            text = formatDate(date),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }

                Spacer(modifier = Modifier.height(24.dp))

                // Content (HTML rendered)
                HtmlContent(
                    html = e.entry.contentCleaned ?: e.entry.contentOriginal ?: "",
                    modifier = Modifier.fillMaxWidth()
                )
            }
        } ?: run {
            // Loading state
            Box(
                modifier = Modifier.fillMaxSize(),
                contentAlignment = Alignment.Center
            ) {
                CircularProgressIndicator()
            }
        }
    }
}

@Composable
fun HtmlContent(
    html: String,
    modifier: Modifier = Modifier
) {
    // Use AndroidView with WebView or a library like Jsoup + AnnotatedString
    AndroidView(
        factory = { context ->
            WebView(context).apply {
                settings.javaScriptEnabled = false
                settings.loadWithOverviewMode = true
                settings.useWideViewPort = true
                isVerticalScrollBarEnabled = false

                // Style the content
                val styledHtml = """
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta name="viewport" content="width=device-width, initial-scale=1">
                        <style>
                            body {
                                font-family: system-ui, -apple-system, sans-serif;
                                font-size: 16px;
                                line-height: 1.6;
                                color: #1a1a1a;
                                padding: 0;
                                margin: 0;
                            }
                            img {
                                max-width: 100%;
                                height: auto;
                            }
                            a {
                                color: #0066cc;
                            }
                            pre, code {
                                background: #f5f5f5;
                                padding: 4px 8px;
                                border-radius: 4px;
                                overflow-x: auto;
                            }
                            blockquote {
                                border-left: 4px solid #ddd;
                                margin-left: 0;
                                padding-left: 16px;
                                color: #666;
                            }
                        </style>
                    </head>
                    <body>$html</body>
                    </html>
                """.trimIndent()

                loadDataWithBaseURL(null, styledHtml, "text/html", "UTF-8", null)
            }
        },
        update = { webView ->
            // Handle content updates
        },
        modifier = modifier
    )
}
```

#### Navigation Drawer

```kotlin
@Composable
fun AppDrawer(
    subscriptions: List<SubscriptionWithTags>,
    tags: List<TagEntity>,
    currentRoute: String,
    onNavigate: (String) -> Unit,
    onSignOut: () -> Unit
) {
    ModalDrawerSheet {
        Column(
            modifier = Modifier
                .fillMaxHeight()
                .verticalScroll(rememberScrollState())
        ) {
            // Header
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(120.dp)
                    .background(MaterialTheme.colorScheme.primaryContainer),
                contentAlignment = Alignment.BottomStart
            ) {
                Text(
                    text = "Lion Reader",
                    style = MaterialTheme.typography.headlineSmall,
                    modifier = Modifier.padding(16.dp)
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            // All entries
            NavigationDrawerItem(
                label = { Text("All") },
                icon = { Icon(Icons.Default.List, null) },
                selected = currentRoute == "all",
                onClick = { onNavigate("all") }
            )

            // Starred
            NavigationDrawerItem(
                label = { Text("Starred") },
                icon = { Icon(Icons.Default.Star, null) },
                selected = currentRoute == "starred",
                onClick = { onNavigate("starred") }
            )

            Divider(modifier = Modifier.padding(vertical = 8.dp))

            // Tags section
            if (tags.isNotEmpty()) {
                Text(
                    text = "Tags",
                    style = MaterialTheme.typography.labelMedium,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                )

                tags.forEach { tag ->
                    NavigationDrawerItem(
                        label = { Text(tag.name) },
                        icon = {
                            tag.color?.let { color ->
                                Box(
                                    modifier = Modifier
                                        .size(12.dp)
                                        .background(
                                            Color(android.graphics.Color.parseColor(color)),
                                            CircleShape
                                        )
                                )
                            } ?: Icon(Icons.Default.Label, null)
                        },
                        badge = {
                            if (tag.feedCount > 0) {
                                Text(tag.feedCount.toString())
                            }
                        },
                        selected = currentRoute == "tag/${tag.id}",
                        onClick = { onNavigate("tag/${tag.id}") }
                    )
                }

                Divider(modifier = Modifier.padding(vertical = 8.dp))
            }

            // Feeds section
            Text(
                text = "Feeds",
                style = MaterialTheme.typography.labelMedium,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
            )

            subscriptions.forEach { sub ->
                NavigationDrawerItem(
                    label = {
                        Text(
                            text = sub.subscription.displayTitle,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis
                        )
                    },
                    icon = { Icon(Icons.Default.RssFeed, null) },
                    badge = {
                        if (sub.subscription.subscription.unreadCount > 0) {
                            Badge {
                                Text(sub.subscription.subscription.unreadCount.toString())
                            }
                        }
                    },
                    selected = currentRoute == "feed/${sub.subscription.subscription.feedId}",
                    onClick = { onNavigate("feed/${sub.subscription.subscription.feedId}") }
                )
            }

            Spacer(modifier = Modifier.weight(1f))

            Divider()

            // Sign out
            NavigationDrawerItem(
                label = { Text("Sign Out") },
                icon = { Icon(Icons.Default.Logout, null) },
                selected = false,
                onClick = onSignOut
            )

            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}
```

---

## Authentication

### Session Management

```kotlin
class SessionStore(
    private val context: Context
) {
    private val prefs = context.getSharedPreferences("auth", Context.MODE_PRIVATE)

    // Use EncryptedSharedPreferences in production
    private val encryptedPrefs = EncryptedSharedPreferences.create(
        context,
        "auth_secure",
        MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build(),
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    fun saveSession(token: String, userId: String, email: String) {
        encryptedPrefs.edit()
            .putString("token", token)
            .putString("userId", userId)
            .putString("email", email)
            .apply()
    }

    fun getToken(): String? = encryptedPrefs.getString("token", null)

    fun getUserId(): String? = encryptedPrefs.getString("userId", null)

    fun getEmail(): String? = encryptedPrefs.getString("email", null)

    fun clearSession() {
        encryptedPrefs.edit().clear().apply()
    }

    fun isLoggedIn(): Boolean = getToken() != null
}
```

### OAuth Flow (Google)

```kotlin
class GoogleAuthManager(
    private val context: Context,
    private val api: LionReaderApi,
    private val sessionStore: SessionStore
) {
    suspend fun startAuth(): Intent {
        // Get auth URL from backend
        val response = api.googleAuthUrl()

        // Store state for verification
        context.getSharedPreferences("oauth", Context.MODE_PRIVATE)
            .edit()
            .putString("google_state", response.state)
            .apply()

        // Create Custom Tab intent
        return CustomTabsIntent.Builder()
            .build()
            .intent
            .apply {
                data = Uri.parse(response.url)
            }
    }

    suspend fun handleCallback(uri: Uri): Result<User> {
        val code = uri.getQueryParameter("code")
            ?: return Result.failure(Exception("Missing code"))

        val returnedState = uri.getQueryParameter("state")
            ?: return Result.failure(Exception("Missing state"))

        // Verify state
        val savedState = context.getSharedPreferences("oauth", Context.MODE_PRIVATE)
            .getString("google_state", null)

        if (returnedState != savedState) {
            return Result.failure(Exception("State mismatch"))
        }

        // Exchange code for session
        return try {
            val response = api.googleCallback(code, returnedState)
            sessionStore.saveSession(
                token = response.sessionToken,
                userId = response.user.id,
                email = response.user.email
            )
            Result.success(response.user)
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}
```

### Deep Link Handling

```xml
<!-- AndroidManifest.xml -->
<activity android:name=".MainActivity"
    android:exported="true">

    <!-- OAuth callback deep link -->
    <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />

        <data
            android:scheme="lionreader"
            android:host="oauth"
            android:pathPrefix="/callback" />
    </intent-filter>
</activity>
```

---

## V2: Audio Narration

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Narration Architecture                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Entry Content                                                   │
│       │                                                          │
│       ▼                                                          │
│  ┌─────────────┐     ┌─────────────┐                            │
│  │ Narration   │────▶│   Server    │  (LLM preprocessing)       │
│  │ Repository  │◀────│   API       │                            │
│  └──────┬──────┘     └─────────────┘                            │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────┐     ┌─────────────┐                            │
│  │ Narration   │────▶│ MediaPlayer │  (TTS or audio file)       │
│  │ Service     │◀────│   /TTS      │                            │
│  │ (Foreground)│     └─────────────┘                            │
│  └──────┬──────┘                                                │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │              MediaSession / Notification                 │    │
│  │  ┌─────┐  ┌───────────────────────┐  ┌─────┐            │    │
│  │  │ ⏮️  │  │   Article Title        │  │ ⏭️  │            │    │
│  │  │ ⏯️  │  │   Feed Name           │  │     │            │    │
│  │  └─────┘  └───────────────────────┘  └─────┘            │    │
│  └─────────────────────────────────────────────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Foreground Service for Background Playback

```kotlin
class NarrationService : Service() {
    private var mediaSession: MediaSessionCompat? = null
    private var tts: TextToSpeech? = null
    private var currentEntry: EntryEntity? = null
    private var narrationText: String? = null
    private var paragraphs: List<String> = emptyList()
    private var currentParagraphIndex = 0
    private var isPlaying = false

    override fun onCreate() {
        super.onCreate()

        // Initialize TTS
        tts = TextToSpeech(this) { status ->
            if (status == TextToSpeech.SUCCESS) {
                tts?.language = Locale.US
            }
        }

        // Create media session
        mediaSession = MediaSessionCompat(this, "NarrationService").apply {
            setCallback(mediaSessionCallback)
            isActive = true
        }

        // Start as foreground service
        startForeground(NOTIFICATION_ID, createNotification())
    }

    private val mediaSessionCallback = object : MediaSessionCompat.Callback() {
        override fun onPlay() {
            resumePlayback()
        }

        override fun onPause() {
            pausePlayback()
        }

        override fun onStop() {
            stopPlayback()
        }

        override fun onSkipToNext() {
            skipToNextParagraph()
        }

        override fun onSkipToPrevious() {
            skipToPreviousParagraph()
        }
    }

    fun startNarration(entry: EntryEntity, narration: String) {
        currentEntry = entry
        narrationText = narration
        paragraphs = narration.split("\n\n").filter { it.isNotBlank() }
        currentParagraphIndex = 0

        updateNotification()
        playCurrentParagraph()
    }

    private fun playCurrentParagraph() {
        if (currentParagraphIndex >= paragraphs.size) {
            stopPlayback()
            return
        }

        val paragraph = paragraphs[currentParagraphIndex]
        isPlaying = true

        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onDone(utteranceId: String?) {
                currentParagraphIndex++
                playCurrentParagraph()
            }

            override fun onError(utteranceId: String?) {
                // Handle error
            }

            override fun onStart(utteranceId: String?) {
                // Update UI with current paragraph
                broadcastProgress()
            }
        })

        tts?.speak(
            paragraph,
            TextToSpeech.QUEUE_FLUSH,
            null,
            "paragraph_$currentParagraphIndex"
        )

        updatePlaybackState(PlaybackStateCompat.STATE_PLAYING)
    }

    private fun pausePlayback() {
        tts?.stop()
        isPlaying = false
        updatePlaybackState(PlaybackStateCompat.STATE_PAUSED)
    }

    private fun resumePlayback() {
        playCurrentParagraph()
    }

    private fun stopPlayback() {
        tts?.stop()
        isPlaying = false
        currentEntry = null
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun skipToNextParagraph() {
        if (currentParagraphIndex < paragraphs.size - 1) {
            currentParagraphIndex++
            playCurrentParagraph()
        }
    }

    private fun skipToPreviousParagraph() {
        if (currentParagraphIndex > 0) {
            currentParagraphIndex--
            playCurrentParagraph()
        }
    }

    private fun createNotification(): Notification {
        val channelId = createNotificationChannel()

        return NotificationCompat.Builder(this, channelId)
            .setContentTitle(currentEntry?.title ?: "Lion Reader")
            .setContentText(currentEntry?.feedTitle ?: "Playing article")
            .setSmallIcon(R.drawable.ic_notification)
            .setOngoing(true)
            .setStyle(
                androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(mediaSession?.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )
            .addAction(
                R.drawable.ic_skip_previous,
                "Previous",
                createPendingIntent(ACTION_PREVIOUS)
            )
            .addAction(
                if (isPlaying) R.drawable.ic_pause else R.drawable.ic_play,
                if (isPlaying) "Pause" else "Play",
                createPendingIntent(if (isPlaying) ACTION_PAUSE else ACTION_PLAY)
            )
            .addAction(
                R.drawable.ic_skip_next,
                "Next",
                createPendingIntent(ACTION_NEXT)
            )
            .build()
    }

    private fun updatePlaybackState(state: Int) {
        val playbackState = PlaybackStateCompat.Builder()
            .setActions(
                PlaybackStateCompat.ACTION_PLAY or
                PlaybackStateCompat.ACTION_PAUSE or
                PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                PlaybackStateCompat.ACTION_STOP
            )
            .setState(state, currentParagraphIndex.toLong(), 1f)
            .build()

        mediaSession?.setPlaybackState(playbackState)
        updateNotification()
    }

    private fun broadcastProgress() {
        // Broadcast current paragraph for UI highlighting
        LocalBroadcastManager.getInstance(this).sendBroadcast(
            Intent(ACTION_NARRATION_PROGRESS).apply {
                putExtra("paragraphIndex", currentParagraphIndex)
                putExtra("totalParagraphs", paragraphs.size)
            }
        )
    }

    companion object {
        const val NOTIFICATION_ID = 1
        const val ACTION_PLAY = "com.lionreader.PLAY"
        const val ACTION_PAUSE = "com.lionreader.PAUSE"
        const val ACTION_NEXT = "com.lionreader.NEXT"
        const val ACTION_PREVIOUS = "com.lionreader.PREVIOUS"
        const val ACTION_NARRATION_PROGRESS = "com.lionreader.NARRATION_PROGRESS"
    }
}
```

### Narration Repository

```kotlin
class NarrationRepository(
    private val api: LionReaderApi,
    private val narrationDao: NarrationDao
) {
    suspend fun getNarration(entryId: String): Result<NarrationResult> {
        // Check cache first
        val cached = narrationDao.getNarration(entryId)
        if (cached != null) {
            return Result.success(
                NarrationResult(
                    text = cached.narrationText,
                    cached = true,
                    source = cached.source
                )
            )
        }

        // Fetch from API
        return try {
            val response = api.generateNarration(type = "entry", id = entryId)

            // Cache locally
            narrationDao.insert(
                NarrationEntity(
                    entryId = entryId,
                    narrationText = response.narration,
                    source = response.source,
                    generatedAt = System.currentTimeMillis()
                )
            )

            Result.success(
                NarrationResult(
                    text = response.narration,
                    cached = response.cached,
                    source = response.source
                )
            )
        } catch (e: Exception) {
            Result.failure(e)
        }
    }
}

data class NarrationResult(
    val text: String,
    val cached: Boolean,
    val source: String  // "llm" or "fallback"
)
```

### UI Integration

```kotlin
@Composable
fun EntryDetailScreen(
    entryId: String,
    viewModel: EntryDetailViewModel = hiltViewModel(),
    narrationViewModel: NarrationViewModel = hiltViewModel(),
    onBack: () -> Unit
) {
    val entry by viewModel.entry.collectAsState()
    val narrationState by narrationViewModel.state.collectAsState()

    Scaffold(
        topBar = { /* ... */ },
        bottomBar = {
            // Narration controls
            entry?.let { e ->
                NarrationControls(
                    state = narrationState,
                    onPlay = { narrationViewModel.play(e.entry) },
                    onPause = { narrationViewModel.pause() },
                    onSkipPrevious = { narrationViewModel.skipPrevious() },
                    onSkipNext = { narrationViewModel.skipNext() }
                )
            }
        }
    ) { padding ->
        // Entry content...
    }
}

@Composable
fun NarrationControls(
    state: NarrationState,
    onPlay: () -> Unit,
    onPause: () -> Unit,
    onSkipPrevious: () -> Unit,
    onSkipNext: () -> Unit
) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        tonalElevation = 4.dp
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(8.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            when (state) {
                is NarrationState.Idle -> {
                    IconButton(onClick = onPlay) {
                        Icon(
                            Icons.Default.PlayArrow,
                            contentDescription = "Play narration",
                            modifier = Modifier.size(32.dp)
                        )
                    }
                }

                is NarrationState.Loading -> {
                    CircularProgressIndicator(modifier = Modifier.size(32.dp))
                }

                is NarrationState.Playing -> {
                    IconButton(onClick = onSkipPrevious) {
                        Icon(Icons.Default.SkipPrevious, "Previous paragraph")
                    }

                    IconButton(onClick = onPause) {
                        Icon(
                            Icons.Default.Pause,
                            contentDescription = "Pause",
                            modifier = Modifier.size(32.dp)
                        )
                    }

                    IconButton(onClick = onSkipNext) {
                        Icon(Icons.Default.SkipNext, "Next paragraph")
                    }

                    Text(
                        text = "${state.currentParagraph + 1}/${state.totalParagraphs}",
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(start = 8.dp)
                    )
                }

                is NarrationState.Paused -> {
                    IconButton(onClick = onSkipPrevious) {
                        Icon(Icons.Default.SkipPrevious, "Previous paragraph")
                    }

                    IconButton(onClick = onPlay) {
                        Icon(
                            Icons.Default.PlayArrow,
                            contentDescription = "Resume",
                            modifier = Modifier.size(32.dp)
                        )
                    }

                    IconButton(onClick = onSkipNext) {
                        Icon(Icons.Default.SkipNext, "Next paragraph")
                    }
                }

                is NarrationState.Error -> {
                    Text(
                        text = "Narration unavailable",
                        color = MaterialTheme.colorScheme.error
                    )
                    IconButton(onClick = onPlay) {
                        Icon(Icons.Default.Refresh, "Retry")
                    }
                }
            }
        }
    }
}

sealed class NarrationState {
    data object Idle : NarrationState()
    data object Loading : NarrationState()
    data class Playing(
        val currentParagraph: Int,
        val totalParagraphs: Int
    ) : NarrationState()
    data class Paused(
        val currentParagraph: Int,
        val totalParagraphs: Int
    ) : NarrationState()
    data class Error(val message: String) : NarrationState()
}
```

---

## Technology Stack

### Core

| Component | Library | Rationale |
|-----------|---------|-----------|
| Language | Kotlin 1.9+ | Modern, concise, null-safe |
| Min SDK | 26 (Android 8.0) | 95%+ device coverage |
| Target SDK | 34 (Android 14) | Latest features |
| UI | Jetpack Compose | Modern declarative UI |
| Navigation | Compose Navigation | Type-safe, integrated |

### Architecture

| Component | Library | Rationale |
|-----------|---------|-----------|
| DI | Hilt | Official, compile-time safe |
| Async | Kotlin Coroutines + Flow | Native, structured concurrency |
| State | StateFlow | Lifecycle-aware, composable |

### Data

| Component | Library | Rationale |
|-----------|---------|-----------|
| Local DB | Room | Official, type-safe, Flow support |
| HTTP | Ktor Client | Kotlin-native, multiplatform ready |
| JSON | Kotlinx Serialization | Native, fast, no reflection |
| Secure Storage | EncryptedSharedPreferences | Token security |

### Background

| Component | Library | Rationale |
|-----------|---------|-----------|
| Background Work | WorkManager | Battery-efficient, constraint-aware |
| Media | Media3 / MediaSession | Modern media controls |
| TTS | Android TextToSpeech | Built-in, no API cost |

### Development

| Component | Library | Rationale |
|-----------|---------|-----------|
| Build | Gradle (KTS) | Type-safe, IDE support |
| Testing | JUnit5, Turbine, MockK | Modern testing stack |
| Lint | Detekt, ktlint | Code quality |

---

## Project Structure

```
app/
├── src/main/
│   ├── java/com/lionreader/
│   │   ├── LionReaderApp.kt           # Application class
│   │   ├── MainActivity.kt            # Single activity
│   │   │
│   │   ├── data/
│   │   │   ├── api/
│   │   │   │   ├── LionReaderApi.kt   # API interface
│   │   │   │   ├── ApiClient.kt       # Ktor setup
│   │   │   │   └── models/            # DTOs
│   │   │   │
│   │   │   ├── db/
│   │   │   │   ├── LionReaderDatabase.kt
│   │   │   │   ├── entities/          # Room entities
│   │   │   │   └── dao/               # DAOs
│   │   │   │
│   │   │   └── repository/
│   │   │       ├── EntryRepository.kt
│   │   │       ├── SubscriptionRepository.kt
│   │   │       ├── AuthRepository.kt
│   │   │       └── NarrationRepository.kt
│   │   │
│   │   ├── domain/
│   │   │   ├── model/                 # Domain models
│   │   │   └── usecase/               # Use cases
│   │   │
│   │   ├── ui/
│   │   │   ├── theme/                 # Material 3 theme
│   │   │   ├── navigation/            # Nav graph
│   │   │   ├── components/            # Reusable composables
│   │   │   │
│   │   │   ├── auth/
│   │   │   │   ├── LoginScreen.kt
│   │   │   │   └── LoginViewModel.kt
│   │   │   │
│   │   │   ├── entries/
│   │   │   │   ├── EntryListScreen.kt
│   │   │   │   ├── EntryListViewModel.kt
│   │   │   │   ├── EntryDetailScreen.kt
│   │   │   │   └── EntryDetailViewModel.kt
│   │   │   │
│   │   │   └── narration/             # V2
│   │   │       ├── NarrationControls.kt
│   │   │       └── NarrationViewModel.kt
│   │   │
│   │   ├── service/
│   │   │   ├── SyncWorker.kt          # Background sync
│   │   │   └── NarrationService.kt    # Foreground TTS service
│   │   │
│   │   └── di/
│   │       ├── AppModule.kt           # Hilt modules
│   │       ├── DatabaseModule.kt
│   │       └── NetworkModule.kt
│   │
│   ├── res/
│   │   ├── drawable/                  # Icons, images
│   │   ├── values/                    # Strings, colors
│   │   └── xml/                       # Network security config
│   │
│   └── AndroidManifest.xml
│
├── build.gradle.kts
└── proguard-rules.pro
```

---

## Summary

### MVP Deliverables

1. **Authentication**: Email/password + Google/Apple OAuth
2. **Entry browsing**: All, starred, by feed, by tag views
3. **Entry reading**: Full article content with HTML rendering
4. **Entry actions**: Mark read/unread, star/unstar
5. **Offline support**: Local Room database, background sync
6. **Sync**: Optimistic updates, pending action queue, WorkManager

### V2 Deliverables

1. **Narration**: TTS-based article reading
2. **Background playback**: Foreground service with MediaSession
3. **Media controls**: Notification controls, lock screen, Bluetooth
4. **Paragraph navigation**: Skip forward/back through content

### Key Technical Decisions

1. **Offline-first**: Local database is source of truth
2. **Optimistic updates**: Immediate UI feedback, async sync
3. **Foreground service**: Required for background audio on modern Android
4. **WorkManager**: Battery-efficient background sync
5. **Compose**: Modern, declarative UI with less boilerplate
