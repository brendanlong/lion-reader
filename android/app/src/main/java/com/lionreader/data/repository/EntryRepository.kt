package com.lionreader.data.repository

import android.util.Log
import com.lionreader.data.api.ApiResult
import com.lionreader.data.api.LionReaderApi
import com.lionreader.data.api.models.EntryDto
import com.lionreader.data.api.models.SortOrder
import com.lionreader.data.api.models.StarredCountResponse
import com.lionreader.data.api.models.SubscriptionWithFeedDto
import com.lionreader.data.api.models.TagDto
import com.lionreader.data.db.dao.EntryDao
import com.lionreader.data.db.dao.EntryStateDao
import com.lionreader.data.db.dao.PendingActionDao
import com.lionreader.data.db.dao.SubscriptionDao
import com.lionreader.data.db.dao.TagDao
import com.lionreader.data.db.entities.EntryEntity
import com.lionreader.data.db.entities.EntryStateEntity
import com.lionreader.data.db.entities.FeedEntity
import com.lionreader.data.db.entities.PendingActionEntity
import com.lionreader.data.db.entities.SubscriptionEntity
import com.lionreader.data.db.entities.SubscriptionTagEntity
import com.lionreader.data.db.entities.TagEntity
import com.lionreader.data.db.relations.EntryWithState
import com.lionreader.data.sync.ConnectivityMonitor
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.firstOrNull
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Filter options for querying entries.
 */
data class EntryFilters(
    val feedId: String? = null,
    val tagId: String? = null,
    val unreadOnly: Boolean = false,
    val starredOnly: Boolean = false,
    val sortOrder: SortOrder = SortOrder.NEWEST,
    val limit: Int = 100,
    val offset: Int = 0,
)

/**
 * Result of an entry fetch operation.
 */
sealed class EntryFetchResult {
    data class Success(
        val entry: EntryWithState,
    ) : EntryFetchResult()

    data object NotFound : EntryFetchResult()

    data class Error(
        val code: String,
        val message: String,
    ) : EntryFetchResult()

    data object NetworkError : EntryFetchResult()
}

/**
 * Result of syncing entries from the server.
 */
data class EntrySyncResult(
    val syncResult: SyncResult,
    val hasMore: Boolean = false,
    val nextCursor: String? = null,
)

/**
 * Repository for entry operations.
 *
 * Provides offline-first access to feed entries. Data is read from the local
 * database via Flow for reactive updates. Supports optimistic updates with
 * offline sync queue for read/star operations.
 *
 * Also handles full sync from server including subscriptions, tags, and entries.
 */
@Singleton
class EntryRepository
    @Inject
    constructor(
        private val api: LionReaderApi,
        private val entryDao: EntryDao,
        private val entryStateDao: EntryStateDao,
        private val pendingActionDao: PendingActionDao,
        private val subscriptionDao: SubscriptionDao,
        private val tagDao: TagDao,
        private val connectivityMonitor: ConnectivityMonitor,
        private val syncRepository: SyncRepository,
    ) {
        companion object {
            private const val TAG = "EntryRepository"

            /**
             * Default page size for entry pagination during sync.
             */
            private const val SYNC_PAGE_SIZE = 100
        }

        // ============================================================================
        // READ OPERATIONS (4.4)
        // ============================================================================

        /**
         * Gets entries from the local database with optional filters.
         *
         * Returns a Flow that automatically updates when the underlying data changes.
         * This is the primary way to observe entries in the UI.
         *
         * @param filters Filter and pagination options
         * @return Flow of entries matching the criteria
         */
        fun getEntries(filters: EntryFilters = EntryFilters()): Flow<List<EntryWithState>> =
            entryDao.getEntries(
                feedId = filters.feedId,
                tagId = filters.tagId,
                unreadOnly = filters.unreadOnly,
                starredOnly = filters.starredOnly,
                sortOrder = filters.sortOrder.value,
                limit = filters.limit,
                offset = filters.offset,
            )

        /**
         * Gets a single entry with its state as a Flow.
         *
         * @param id Entry ID
         * @return Flow of the entry with state or null
         */
        fun getEntryFlow(id: String): Flow<EntryWithState?> = entryDao.getEntryWithState(id)

        /**
         * Fetches the starred entries count from the server.
         *
         * @return StarredCountResponse with total and unread counts, or null on failure
         */
        suspend fun fetchStarredCount(): StarredCountResponse? =
            when (val result = api.getStarredCount()) {
                is ApiResult.Success -> result.data
                else -> null
            }

        /**
         * Gets a single entry by ID, fetching from server if not in local database.
         *
         * First checks the local database. If not found, attempts to fetch from the
         * server and store locally before returning.
         *
         * @param id Entry ID
         * @return EntryFetchResult containing the entry or an error
         */
        suspend fun getEntry(id: String): EntryFetchResult {
            // First try to get from local database
            val localEntry = entryDao.getEntryWithState(id).firstOrNull()
            if (localEntry != null) {
                return EntryFetchResult.Success(localEntry)
            }

            // Not found locally, try to fetch from server
            return when (val result = api.getEntry(id)) {
                is ApiResult.Success -> {
                    val dto = result.data.entry
                    val entity = mapEntryDtoToEntity(dto)
                    entryDao.insertEntries(listOf(entity))

                    // Create state from DTO
                    val state =
                        EntryStateEntity(
                            entryId = dto.id,
                            read = dto.read,
                            starred = dto.starred,
                            readAt = null,
                            starredAt = null,
                            pendingSync = false,
                            lastModifiedAt = System.currentTimeMillis(),
                        )
                    entryStateDao.upsertState(state)

                    // Get the freshly inserted entry with state
                    val freshEntry = entryDao.getEntryWithState(id).firstOrNull()
                    if (freshEntry != null) {
                        EntryFetchResult.Success(freshEntry)
                    } else {
                        EntryFetchResult.NotFound
                    }
                }
                is ApiResult.Error -> {
                    if (result.code == "NOT_FOUND") {
                        EntryFetchResult.NotFound
                    } else {
                        EntryFetchResult.Error(result.code, result.message)
                    }
                }
                is ApiResult.NetworkError -> {
                    EntryFetchResult.NetworkError
                }
                is ApiResult.Unauthorized -> {
                    EntryFetchResult.Error("UNAUTHORIZED", "Session expired")
                }
                is ApiResult.RateLimited -> {
                    EntryFetchResult.Error("RATE_LIMITED", "Too many requests")
                }
            }
        }

        /**
         * Syncs entries from the server with optional filters and pagination.
         *
         * Fetches entries from the API and updates the local database. Supports
         * cursor-based pagination for fetching large sets of entries.
         *
         * @param filters Filter options for the sync
         * @param cursor Pagination cursor from previous sync
         * @return EntrySyncResult with sync status and pagination info
         */
        suspend fun syncEntries(
            filters: EntryFilters = EntryFilters(),
            cursor: String? = null,
        ): EntrySyncResult {
            val result =
                api.listEntries(
                    feedId = filters.feedId,
                    tagId = filters.tagId,
                    unreadOnly = if (filters.unreadOnly) true else null,
                    starredOnly = if (filters.starredOnly) true else null,
                    sortOrder = filters.sortOrder,
                    cursor = cursor,
                    limit = filters.limit,
                )

            return when (result) {
                is ApiResult.Success -> {
                    val response = result.data
                    updateLocalEntries(response.items)

                    EntrySyncResult(
                        syncResult = SyncResult.Success,
                        hasMore = response.nextCursor != null,
                        nextCursor = response.nextCursor,
                    )
                }
                is ApiResult.Error -> {
                    EntrySyncResult(SyncResult.Error(result.code, result.message))
                }
                is ApiResult.NetworkError -> {
                    EntrySyncResult(SyncResult.NetworkError)
                }
                is ApiResult.Unauthorized -> {
                    EntrySyncResult(SyncResult.Error("UNAUTHORIZED", "Session expired"))
                }
                is ApiResult.RateLimited -> {
                    EntrySyncResult(SyncResult.Error("RATE_LIMITED", "Too many requests"))
                }
            }
        }

        /**
         * Syncs all entries with pagination, fetching until no more pages.
         *
         * @param filters Filter options for the sync
         * @param onProgress Optional callback for progress updates
         * @return SyncResult indicating overall success or failure
         */
        suspend fun syncAllEntries(
            filters: EntryFilters = EntryFilters(),
            onProgress: ((fetchedCount: Int) -> Unit)? = null,
        ): SyncResult {
            var cursor: String? = null
            var totalFetched = 0

            do {
                val result = syncEntries(filters.copy(limit = 100), cursor)

                when (result.syncResult) {
                    is SyncResult.Success -> {
                        totalFetched += 100 // Approximate, could track actual count
                        onProgress?.invoke(totalFetched)
                        cursor = result.nextCursor
                    }
                    else -> {
                        return result.syncResult
                    }
                }
            } while (result.hasMore && cursor != null)

            return SyncResult.Success
        }

        // ============================================================================
        // WRITE OPERATIONS WITH OFFLINE SUPPORT (4.5)
        // ============================================================================

        /**
         * Marks an entry as read or unread.
         *
         * Updates local state immediately (optimistic update) and queues the action
         * for sync. If online, attempts immediate sync.
         *
         * @param entryId Entry ID
         * @param read true to mark as read, false to mark as unread
         */
        suspend fun markRead(
            entryId: String,
            read: Boolean,
        ) {
            val now = System.currentTimeMillis()

            // Ensure state exists before updating
            ensureStateExists(entryId)

            // 1. Update local state immediately (optimistic update)
            entryStateDao.markRead(
                entryId = entryId,
                read = read,
                readAt = if (read) now else null,
                modifiedAt = now,
            )

            // 2. Queue for sync
            pendingActionDao.insert(
                PendingActionEntity(
                    type = if (read) PendingActionEntity.TYPE_MARK_READ else PendingActionEntity.TYPE_MARK_UNREAD,
                    entryId = entryId,
                    createdAt = now,
                ),
            )

            // 3. Attempt immediate sync if online
            // Note: Using placeholder check for now - will be replaced with ConnectivityMonitor
            if (isOnline()) {
                // Sync will be handled by SyncRepository
                // This is just a placeholder trigger
            }
        }

        /**
         * Sets the starred status of an entry.
         *
         * Updates local state immediately (optimistic update) and queues the action
         * for sync. If online, attempts immediate sync.
         *
         * @param entryId Entry ID
         * @param starred true to star, false to unstar
         */
        suspend fun setStarred(
            entryId: String,
            starred: Boolean,
        ) {
            val now = System.currentTimeMillis()

            // Ensure state exists before updating
            ensureStateExists(entryId)

            // 1. Update local state immediately (optimistic update)
            entryStateDao.setStarred(
                entryId = entryId,
                starred = starred,
                starredAt = if (starred) now else null,
                modifiedAt = now,
            )

            // 2. Queue for sync
            pendingActionDao.insert(
                PendingActionEntity(
                    type = if (starred) PendingActionEntity.TYPE_STAR else PendingActionEntity.TYPE_UNSTAR,
                    entryId = entryId,
                    createdAt = now,
                ),
            )

            // 3. Attempt immediate sync if online
            // Note: Using placeholder check for now - will be replaced with ConnectivityMonitor
            if (isOnline()) {
                // Sync will be handled by SyncRepository
                // This is just a placeholder trigger
            }
        }

        /**
         * Toggles the read status of an entry.
         *
         * @param entryId Entry ID
         */
        suspend fun toggleRead(entryId: String) {
            val currentState = entryStateDao.getState(entryId)
            val isCurrentlyRead = currentState?.read ?: false
            markRead(entryId, !isCurrentlyRead)
        }

        /**
         * Toggles the starred status of an entry.
         *
         * @param entryId Entry ID
         */
        suspend fun toggleStarred(entryId: String) {
            val currentState = entryStateDao.getState(entryId)
            val isCurrentlyStarred = currentState?.starred ?: false
            setStarred(entryId, !isCurrentlyStarred)
        }

        // ============================================================================
        // HELPER METHODS
        // ============================================================================

        /**
         * Ensures an entry state record exists for the given entry.
         *
         * Creates a default state if one doesn't exist yet.
         */
        private suspend fun ensureStateExists(entryId: String) {
            val existingState = entryStateDao.getState(entryId)
            if (existingState == null) {
                entryStateDao.upsertState(
                    EntryStateEntity(
                        entryId = entryId,
                        read = false,
                        starred = false,
                        readAt = null,
                        starredAt = null,
                        pendingSync = false,
                        lastModifiedAt = System.currentTimeMillis(),
                    ),
                )
            }
        }

        /**
         * Updates local entries and their states from API response.
         */
        private suspend fun updateLocalEntries(entries: List<EntryDto>) {
            val now = System.currentTimeMillis()

            // Map DTOs to entities
            val entryEntities = entries.map { mapEntryDtoToEntity(it) }
            entryDao.insertEntries(entryEntities)

            // Update states from server (only for entries without pending sync)
            val states =
                entries.map { entry ->
                    EntryStateEntity(
                        entryId = entry.id,
                        read = entry.read,
                        starred = entry.starred,
                        readAt = null,
                        starredAt = null,
                        pendingSync = false,
                        lastModifiedAt = now,
                    )
                }

            // Only update states that don't have pending sync
            val pendingEntryIds = entryStateDao.getPendingSyncEntryIds()
            val statesToUpdate = states.filter { it.entryId !in pendingEntryIds }
            entryStateDao.upsertStates(statesToUpdate)
        }

        /**
         * Maps an EntryDto from the API to an EntryEntity for local storage.
         */
        private fun mapEntryDtoToEntity(dto: EntryDto): EntryEntity =
            EntryEntity(
                id = dto.id,
                feedId = dto.feedId,
                url = dto.url,
                title = dto.title,
                author = dto.author,
                summary = dto.summary,
                contentOriginal = dto.contentOriginal,
                contentCleaned = dto.contentCleaned,
                publishedAt = dto.publishedAt?.let { parseIsoTimestamp(it) },
                fetchedAt = parseIsoTimestamp(dto.fetchedAt),
                feedTitle = dto.feedTitle,
                lastSyncedAt = System.currentTimeMillis(),
            )

        /**
         * Parses an ISO 8601 timestamp string to milliseconds.
         */
        private fun parseIsoTimestamp(timestamp: String): Long =
            try {
                Instant.parse(timestamp).toEpochMilli()
            } catch (e: Exception) {
                System.currentTimeMillis()
            }

        /**
         * Checks if the device has network connectivity.
         *
         * @return true if online, false otherwise
         */
        private fun isOnline(): Boolean = connectivityMonitor.checkOnline()

        // ============================================================================
        // FULL SYNC FROM SERVER (5.4)
        // ============================================================================

        /**
         * Performs a full sync from the server.
         *
         * This method:
         * 1. Pushes pending local changes to the server
         * 2. Fetches and stores subscriptions (includes unread counts)
         * 3. Fetches and stores tags
         * 4. Fetches and stores entries with pagination
         * 5. Updates local entry states from server (server wins for non-pending items)
         *
         * @return SyncResult indicating success or the type of failure
         */
        suspend fun syncFromServer(): SyncResult {
            Log.d(TAG, "Starting full sync from server")

            // Step 1: Push pending local changes first
            Log.d(TAG, "Syncing pending actions...")
            val pendingResult = syncRepository.syncPendingActions()
            Log.d(
                TAG,
                "Pending sync complete: ${pendingResult.processedCount} processed, " +
                    "${pendingResult.failedCount} failed",
            )

            // Step 2: Fetch subscriptions (includes unread counts)
            Log.d(TAG, "Fetching subscriptions...")
            val subscriptionsResult = syncSubscriptions()
            if (subscriptionsResult !is SyncResult.Success) {
                Log.e(TAG, "Failed to sync subscriptions: $subscriptionsResult")
                return subscriptionsResult
            }
            Log.d(TAG, "Subscriptions synced successfully")

            // Step 3: Fetch tags
            Log.d(TAG, "Fetching tags...")
            val tagsResult = syncTags()
            if (tagsResult !is SyncResult.Success) {
                Log.e(TAG, "Failed to sync tags: $tagsResult")
                return tagsResult
            }
            Log.d(TAG, "Tags synced successfully")

            // Step 4: Fetch entries with pagination
            Log.d(TAG, "Fetching entries...")
            val entriesResult = syncAllEntriesFromServer()
            if (entriesResult !is SyncResult.Success) {
                Log.e(TAG, "Failed to sync entries: $entriesResult")
                return entriesResult
            }
            Log.d(TAG, "Entries synced successfully")

            Log.d(TAG, "Full sync completed successfully")
            return SyncResult.Success
        }

        /**
         * Syncs subscriptions from the server.
         */
        private suspend fun syncSubscriptions(): SyncResult =
            when (val result = api.listSubscriptions()) {
                is ApiResult.Success -> {
                    updateLocalSubscriptions(result.data.items)
                    SyncResult.Success
                }
                is ApiResult.Error -> {
                    SyncResult.Error(result.code, result.message)
                }
                is ApiResult.NetworkError -> {
                    SyncResult.NetworkError
                }
                is ApiResult.Unauthorized -> {
                    SyncResult.Error("UNAUTHORIZED", "Session expired")
                }
                is ApiResult.RateLimited -> {
                    SyncResult.Error("RATE_LIMITED", "Too many requests")
                }
            }

        /**
         * Updates the local database with subscription data from the API.
         */
        private suspend fun updateLocalSubscriptions(items: List<SubscriptionWithFeedDto>) {
            val now = System.currentTimeMillis()

            // Extract feeds and insert them first (due to foreign key constraint)
            val feeds =
                items.map { item ->
                    FeedEntity(
                        id = item.feed.id,
                        type = item.feed.type,
                        url = item.feed.url,
                        title = item.feed.title,
                        description = item.feed.description,
                        siteUrl = item.feed.siteUrl,
                        lastSyncedAt = now,
                    )
                }
            subscriptionDao.insertFeeds(feeds)

            // Map subscription DTOs to entities
            val subscriptionEntities =
                items.map { item ->
                    SubscriptionEntity(
                        id = item.subscription.id,
                        feedId = item.subscription.feedId,
                        customTitle = item.subscription.customTitle,
                        subscribedAt = parseIsoTimestamp(item.subscription.subscribedAt),
                        unreadCount = item.subscription.unreadCount,
                        lastSyncedAt = now,
                    )
                }
            subscriptionDao.insertAll(subscriptionEntities)

            // Extract tags from subscriptions and update tag associations
            val allTags = mutableMapOf<String, TagEntity>()
            val subscriptionTags = mutableListOf<SubscriptionTagEntity>()

            items.forEach { item ->
                item.subscription.tags.forEach { tagDto ->
                    // Store unique tags
                    allTags[tagDto.id] =
                        TagEntity(
                            id = tagDto.id,
                            name = tagDto.name,
                            color = tagDto.color,
                            feedCount = 0, // Will be calculated separately if needed
                        )
                    // Store subscription-tag relationship
                    subscriptionTags.add(
                        SubscriptionTagEntity(
                            subscriptionId = item.subscription.id,
                            tagId = tagDto.id,
                        ),
                    )
                }
            }

            // Insert tags and subscription-tag relationships
            if (allTags.isNotEmpty()) {
                tagDao.insertAll(allTags.values.toList())
            }

            // Clear old subscription-tag relationships and insert new ones
            tagDao.deleteAllSubscriptionTags()
            if (subscriptionTags.isNotEmpty()) {
                tagDao.insertSubscriptionTags(subscriptionTags)
            }
        }

        /**
         * Syncs tags from the server.
         */
        private suspend fun syncTags(): SyncResult =
            when (val result = api.listTags()) {
                is ApiResult.Success -> {
                    val tags = result.data.tags
                    updateLocalTags(tags)
                    SyncResult.Success
                }
                is ApiResult.Error -> {
                    SyncResult.Error(result.code, result.message)
                }
                is ApiResult.NetworkError -> {
                    SyncResult.NetworkError
                }
                is ApiResult.Unauthorized -> {
                    SyncResult.Error("UNAUTHORIZED", "Session expired")
                }
                is ApiResult.RateLimited -> {
                    SyncResult.Error("RATE_LIMITED", "Too many requests")
                }
            }

        /**
         * Updates the local database with tag data from the API.
         */
        private suspend fun updateLocalTags(tags: List<TagDto>) {
            val tagEntities =
                tags.map { dto ->
                    TagEntity(
                        id = dto.id,
                        name = dto.name,
                        color = dto.color,
                        feedCount = dto.feedCount,
                    )
                }
            tagDao.insertAll(tagEntities)
        }

        /**
         * Syncs all entries from the server with pagination.
         *
         * Fetches entries page by page until no more pages are available.
         * Updates local entry states from server, with server winning for
         * non-pending items (items without local changes waiting to sync).
         */
        private suspend fun syncAllEntriesFromServer(): SyncResult {
            var cursor: String? = null
            var totalFetched = 0

            do {
                val result =
                    api.listEntries(
                        cursor = cursor,
                        limit = SYNC_PAGE_SIZE,
                    )

                when (result) {
                    is ApiResult.Success -> {
                        val response = result.data
                        updateLocalEntriesWithConflictResolution(response.items)
                        totalFetched += response.items.size
                        cursor = response.nextCursor
                        Log.d(TAG, "Fetched ${response.items.size} entries (total: $totalFetched)")
                    }
                    is ApiResult.Error -> {
                        return SyncResult.Error(result.code, result.message)
                    }
                    is ApiResult.NetworkError -> {
                        return SyncResult.NetworkError
                    }
                    is ApiResult.Unauthorized -> {
                        return SyncResult.Error("UNAUTHORIZED", "Session expired")
                    }
                    is ApiResult.RateLimited -> {
                        return SyncResult.Error("RATE_LIMITED", "Too many requests")
                    }
                }
            } while (cursor != null)

            Log.d(TAG, "Finished syncing $totalFetched entries")
            return SyncResult.Success
        }

        /**
         * Updates local entries and states with conflict resolution.
         *
         * For each entry:
         * - Entry content is always updated from server
         * - Entry state (read/starred) is only updated if there's no pending local change
         * - Pending local changes take precedence (they'll be synced on next push)
         */
        private suspend fun updateLocalEntriesWithConflictResolution(entries: List<EntryDto>) {
            val now = System.currentTimeMillis()

            // Get IDs of entries with pending sync (local changes not yet pushed)
            val pendingEntryIds = entryStateDao.getPendingSyncEntryIds().toSet()

            // Map DTOs to entities and insert entries
            val entryEntities = entries.map { mapEntryDtoToEntity(it) }
            entryDao.insertEntries(entryEntities)

            // Update states from server, respecting pending local changes
            entries.forEach { entry ->
                if (entry.id !in pendingEntryIds) {
                    // No pending local change - server wins
                    val state =
                        EntryStateEntity(
                            entryId = entry.id,
                            read = entry.read,
                            starred = entry.starred,
                            readAt = null,
                            starredAt = null,
                            pendingSync = false,
                            lastModifiedAt = now,
                        )
                    entryStateDao.upsertState(state)
                }
                // If entry has pending sync, we keep the local state
                // It will be pushed to server on next sync
            }
        }

        /**
         * Clears all local entry data.
         *
         * Called when logging out to remove all cached data.
         */
        suspend fun clearAll() {
            pendingActionDao.deleteFailedActions()
            // Entry and state deletion is handled by cascade from feeds
        }

        /**
         * Gets the count of pending actions waiting to sync.
         *
         * @return Number of pending actions
         */
        suspend fun getPendingActionCount(): Int = pendingActionDao.getPendingCount()
    }
