package com.lionreader.data.repository

import com.lionreader.data.api.ApiResult
import com.lionreader.data.api.LionReaderApi
import com.lionreader.data.api.models.EntryDto
import com.lionreader.data.api.models.SortOrder
import com.lionreader.data.db.dao.EntryDao
import com.lionreader.data.db.dao.EntryStateDao
import com.lionreader.data.db.dao.PendingActionDao
import com.lionreader.data.db.entities.EntryEntity
import com.lionreader.data.db.entities.EntryStateEntity
import com.lionreader.data.db.entities.PendingActionEntity
import com.lionreader.data.db.relations.EntryWithState
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
    data class Success(val entry: EntryWithState) : EntryFetchResult()
    data object NotFound : EntryFetchResult()
    data class Error(val code: String, val message: String) : EntryFetchResult()
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
 */
@Singleton
class EntryRepository @Inject constructor(
    private val api: LionReaderApi,
    private val entryDao: EntryDao,
    private val entryStateDao: EntryStateDao,
    private val pendingActionDao: PendingActionDao,
) {

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
    fun getEntries(filters: EntryFilters = EntryFilters()): Flow<List<EntryWithState>> {
        return entryDao.getEntries(
            feedId = filters.feedId,
            tagId = filters.tagId,
            unreadOnly = filters.unreadOnly,
            starredOnly = filters.starredOnly,
            sortOrder = filters.sortOrder.value,
            limit = filters.limit,
            offset = filters.offset,
        )
    }

    /**
     * Gets a single entry with its state as a Flow.
     *
     * @param id Entry ID
     * @return Flow of the entry with state or null
     */
    fun getEntryFlow(id: String): Flow<EntryWithState?> {
        return entryDao.getEntryWithState(id)
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
                val state = EntryStateEntity(
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
        val result = api.listEntries(
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
    suspend fun markRead(entryId: String, read: Boolean) {
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
            )
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
    suspend fun setStarred(entryId: String, starred: Boolean) {
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
            )
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
                )
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
        val states = entries.map { entry ->
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
    private fun mapEntryDtoToEntity(dto: EntryDto): EntryEntity {
        return EntryEntity(
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
    }

    /**
     * Parses an ISO 8601 timestamp string to milliseconds.
     */
    private fun parseIsoTimestamp(timestamp: String): Long {
        return try {
            Instant.parse(timestamp).toEpochMilli()
        } catch (e: Exception) {
            System.currentTimeMillis()
        }
    }

    /**
     * Placeholder connectivity check.
     *
     * This will be replaced with a proper ConnectivityMonitor injection.
     * For now, returns true to allow sync attempts.
     *
     * @return true if online (placeholder always returns true)
     */
    private fun isOnline(): Boolean {
        // TODO: Replace with ConnectivityMonitor.isOnline()
        return true
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
    suspend fun getPendingActionCount(): Int {
        return pendingActionDao.getPendingCount()
    }
}
