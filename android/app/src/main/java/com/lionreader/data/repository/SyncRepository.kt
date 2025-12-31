package com.lionreader.data.repository

import android.util.Log
import com.lionreader.data.api.ApiResult
import com.lionreader.data.api.LionReaderApi
import com.lionreader.data.db.dao.EntryStateDao
import com.lionreader.data.db.dao.PendingActionDao
import com.lionreader.data.db.entities.PendingActionEntity
import com.lionreader.data.sync.SyncErrorNotifier
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Result of syncing pending actions.
 */
data class PendingSyncResult(
    val success: Boolean,
    val processedCount: Int,
    val failedCount: Int,
    val errors: List<String> = emptyList(),
)

/**
 * Repository for synchronization operations.
 *
 * Handles syncing pending offline actions to the server. Actions are processed
 * in batches where possible (mark read/unread) and individually for star/unstar.
 * Failed actions are retried with exponential backoff, and permanently failed
 * actions are cleaned up.
 */
@Singleton
class SyncRepository
    @Inject
    constructor(
        private val api: LionReaderApi,
        private val pendingActionDao: PendingActionDao,
        private val entryStateDao: EntryStateDao,
        private val syncErrorNotifier: SyncErrorNotifier,
    ) {
        companion object {
            private const val TAG = "SyncRepository"
        }

        /**
         * Processes all pending actions queued for sync.
         *
         * Groups mark_read and mark_unread actions for efficient bulk API calls.
         * Star and unstar actions are processed individually since the API
         * doesn't support bulk operations for these.
         *
         * @return PendingSyncResult with statistics about the sync operation
         */
        suspend fun syncPendingActions(): PendingSyncResult {
            val allActions = pendingActionDao.getAllPending()

            if (allActions.isEmpty()) {
                return PendingSyncResult(
                    success = true,
                    processedCount = 0,
                    failedCount = 0,
                )
            }

            var processedCount = 0
            var failedCount = 0
            val errors = mutableListOf<String>()
            val syncedEntryIds = mutableListOf<String>()

            // Group actions by type for efficient processing
            val readActions = allActions.filter { it.type == PendingActionEntity.TYPE_MARK_READ }
            val unreadActions = allActions.filter { it.type == PendingActionEntity.TYPE_MARK_UNREAD }
            val starActions = allActions.filter { it.type == PendingActionEntity.TYPE_STAR }
            val unstarActions = allActions.filter { it.type == PendingActionEntity.TYPE_UNSTAR }

            // Process bulk mark read actions
            if (readActions.isNotEmpty()) {
                val result = processBulkMarkRead(readActions, read = true)
                processedCount += result.processedCount
                failedCount += result.failedCount
                syncedEntryIds.addAll(result.syncedEntryIds)
                errors.addAll(result.errors)
            }

            // Process bulk mark unread actions
            if (unreadActions.isNotEmpty()) {
                val result = processBulkMarkRead(unreadActions, read = false)
                processedCount += result.processedCount
                failedCount += result.failedCount
                syncedEntryIds.addAll(result.syncedEntryIds)
                errors.addAll(result.errors)
            }

            // Process star actions one at a time
            starActions.forEach { action ->
                val result = processSingleStarAction(action, star = true)
                if (result.success) {
                    processedCount++
                    syncedEntryIds.add(action.entryId)
                } else {
                    failedCount++
                    result.error?.let { errors.add(it) }
                }
            }

            // Process unstar actions one at a time
            unstarActions.forEach { action ->
                val result = processSingleStarAction(action, star = false)
                if (result.success) {
                    processedCount++
                    syncedEntryIds.add(action.entryId)
                } else {
                    failedCount++
                    result.error?.let { errors.add(it) }
                }
            }

            // Clear pending sync flags for successfully synced entries
            if (syncedEntryIds.isNotEmpty()) {
                entryStateDao.clearPendingSync(syncedEntryIds)
            }

            // Clean up failed actions that exceeded max retries
            pendingActionDao.deleteFailedActions()

            // Emit errors to UI if any occurred
            if (errors.isNotEmpty()) {
                errors.forEach { error ->
                    syncErrorNotifier.emit(
                        message = "Sync error: $error",
                        isAuthError = error.contains("Session expired", ignoreCase = true),
                    )
                }
            }

            return PendingSyncResult(
                success = failedCount == 0,
                processedCount = processedCount,
                failedCount = failedCount,
                errors = errors,
            )
        }

        /**
         * Processes bulk mark read/unread actions.
         *
         * Sends a single API request with all entry IDs for efficiency.
         */
        private suspend fun processBulkMarkRead(
            actions: List<PendingActionEntity>,
            read: Boolean,
        ): BulkActionResult {
            val entryIds = actions.map { it.entryId }

            return when (val result = api.markRead(entryIds, read)) {
                is ApiResult.Success -> {
                    // Delete all processed actions
                    pendingActionDao.deleteAll(actions)
                    BulkActionResult(
                        processedCount = actions.size,
                        failedCount = 0,
                        syncedEntryIds = entryIds,
                    )
                }
                is ApiResult.Error -> {
                    Log.e(TAG, "Bulk mark read failed: ${result.code} - ${result.message}")
                    handleBulkFailure(actions, "Mark ${if (read) "read" else "unread"} failed: ${result.message}")
                }
                is ApiResult.NetworkError -> {
                    Log.e(TAG, "Network error during bulk mark read")
                    handleBulkFailure(actions, "Network error during sync")
                }
                is ApiResult.Unauthorized -> {
                    Log.e(TAG, "Unauthorized during bulk mark read")
                    // Don't increment retry for auth errors - let the app handle re-auth
                    BulkActionResult(
                        processedCount = 0,
                        failedCount = actions.size,
                        syncedEntryIds = emptyList(),
                        errors = listOf("Session expired. Please log in again."),
                    )
                }
                is ApiResult.RateLimited -> {
                    Log.e(TAG, "Rate limited during bulk mark read")
                    handleBulkFailure(actions, "Rate limited. Will retry later.")
                }
            }
        }

        /**
         * Handles failure for bulk actions by incrementing retry counts.
         */
        private suspend fun handleBulkFailure(
            actions: List<PendingActionEntity>,
            errorMessage: String,
        ): BulkActionResult {
            actions.forEach { action ->
                pendingActionDao.incrementRetry(action.id)
            }
            return BulkActionResult(
                processedCount = 0,
                failedCount = actions.size,
                syncedEntryIds = emptyList(),
                errors = listOf(errorMessage),
            )
        }

        /**
         * Processes a single star/unstar action.
         */
        private suspend fun processSingleStarAction(
            action: PendingActionEntity,
            star: Boolean,
        ): SingleActionResult {
            val result =
                if (star) {
                    api.star(action.entryId)
                } else {
                    api.unstar(action.entryId)
                }

            return when (result) {
                is ApiResult.Success -> {
                    pendingActionDao.delete(action)
                    SingleActionResult(success = true)
                }
                is ApiResult.Error -> {
                    Log.e(TAG, "Star action failed: ${result.code} - ${result.message}")
                    pendingActionDao.incrementRetry(action.id)
                    SingleActionResult(
                        success = false,
                        error = "${if (star) "Star" else "Unstar"} failed: ${result.message}",
                    )
                }
                is ApiResult.NetworkError -> {
                    Log.e(TAG, "Network error during star action")
                    pendingActionDao.incrementRetry(action.id)
                    SingleActionResult(
                        success = false,
                        error = "Network error during sync",
                    )
                }
                is ApiResult.Unauthorized -> {
                    Log.e(TAG, "Unauthorized during star action")
                    // Don't increment retry for auth errors
                    SingleActionResult(
                        success = false,
                        error = "Session expired. Please log in again.",
                    )
                }
                is ApiResult.RateLimited -> {
                    Log.e(TAG, "Rate limited during star action")
                    pendingActionDao.incrementRetry(action.id)
                    SingleActionResult(
                        success = false,
                        error = "Rate limited. Will retry later.",
                    )
                }
            }
        }

        /**
         * Gets the count of pending actions.
         *
         * @return Number of actions waiting to be synced
         */
        suspend fun getPendingCount(): Int = pendingActionDao.getPendingCount()

        /**
         * Gets the count of failed actions (exceeded max retries).
         *
         * @return Number of permanently failed actions
         */
        suspend fun getFailedCount(): Int = pendingActionDao.getFailedCount()

        /**
         * Clears all failed actions.
         *
         * Call this after informing the user that some actions couldn't be synced.
         */
        suspend fun clearFailedActions() {
            pendingActionDao.deleteFailedActions()
        }

        /**
         * Checks if there are any pending actions to sync.
         *
         * @return true if there are pending actions
         */
        suspend fun hasPendingActions(): Boolean = pendingActionDao.getPendingCount() > 0

        /**
         * Result of processing bulk actions.
         */
        private data class BulkActionResult(
            val processedCount: Int,
            val failedCount: Int,
            val syncedEntryIds: List<String>,
            val errors: List<String> = emptyList(),
        )

        /**
         * Result of processing a single action.
         */
        private data class SingleActionResult(
            val success: Boolean,
            val error: String? = null,
        )
    }
