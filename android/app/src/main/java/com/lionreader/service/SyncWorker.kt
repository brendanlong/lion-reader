package com.lionreader.service

import android.content.Context
import android.util.Log
import androidx.hilt.work.HiltWorker
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.lionreader.data.repository.EntryRepository
import com.lionreader.data.repository.SyncRepository
import com.lionreader.data.repository.SyncResult
import dagger.assisted.Assisted
import dagger.assisted.AssistedInject

/**
 * Background worker for synchronizing data with the server.
 *
 * This worker is responsible for:
 * 1. Pushing pending local changes to the server (via [SyncRepository])
 * 2. Pulling latest data from the server (via [EntryRepository.syncFromServer])
 *
 * The worker uses exponential backoff for retries and is constrained to run
 * only when network connectivity is available.
 *
 * Hilt injects the required dependencies via @HiltWorker and @AssistedInject.
 */
@HiltWorker
class SyncWorker
    @AssistedInject
    constructor(
        @Assisted appContext: Context,
        @Assisted workerParams: WorkerParameters,
        private val syncRepository: SyncRepository,
        private val entryRepository: EntryRepository,
    ) : CoroutineWorker(appContext, workerParams) {
        companion object {
            private const val TAG = "SyncWorker"

            /**
             * Unique work name for periodic sync.
             */
            const val PERIODIC_SYNC_WORK_NAME = "periodic_sync"

            /**
             * Tag for one-time immediate sync requests.
             */
            const val IMMEDIATE_SYNC_TAG = "immediate_sync"

            /**
             * Maximum number of retries before giving up.
             */
            private const val MAX_RETRIES = 3
        }

        override suspend fun doWork(): Result {
            Log.d(TAG, "Starting sync work (attempt ${runAttemptCount + 1})")

            return try {
                // Step 1: Push pending local changes to server
                Log.d(TAG, "Syncing pending actions...")
                val pendingResult = syncRepository.syncPendingActions()

                if (!pendingResult.success && pendingResult.errors.isNotEmpty()) {
                    Log.w(TAG, "Some pending actions failed: ${pendingResult.errors}")
                    // Continue with sync even if some pending actions failed
                    // They will be retried on the next sync
                }

                Log.d(
                    TAG,
                    "Pending sync complete: ${pendingResult.processedCount} processed, " +
                        "${pendingResult.failedCount} failed",
                )

                // Step 2: Pull latest data from server
                Log.d(TAG, "Syncing from server...")
                val syncResult = entryRepository.syncFromServer()

                when (syncResult) {
                    is SyncResult.Success -> {
                        Log.d(TAG, "Sync completed successfully")
                        Result.success()
                    }

                    is SyncResult.NetworkError -> {
                        Log.w(TAG, "Network error during sync")
                        handleRetry("Network error")
                    }

                    is SyncResult.Error -> {
                        Log.e(TAG, "Sync error: ${syncResult.code} - ${syncResult.message}")

                        // Don't retry for auth errors - require user intervention
                        if (syncResult.code == "UNAUTHORIZED") {
                            Log.e(TAG, "Unauthorized - user needs to re-authenticate")
                            Result.failure()
                        } else {
                            handleRetry(syncResult.message)
                        }
                    }
                }
            } catch (e: Exception) {
                Log.e(TAG, "Exception during sync", e)
                handleRetry(e.message ?: "Unknown error")
            }
        }

        /**
         * Determines whether to retry the work based on attempt count.
         *
         * Uses the built-in exponential backoff configured in the work request.
         * Returns [Result.failure] if max retries exceeded.
         */
        private fun handleRetry(reason: String): Result =
            if (runAttemptCount < MAX_RETRIES) {
                Log.d(TAG, "Retrying sync (attempt ${runAttemptCount + 1} of $MAX_RETRIES): $reason")
                Result.retry()
            } else {
                Log.e(TAG, "Max retries exceeded, failing sync: $reason")
                Result.failure()
            }
    }
