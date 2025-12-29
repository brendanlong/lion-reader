package com.lionreader.data.sync

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import com.lionreader.service.SyncWorker
import dagger.hilt.android.qualifiers.ApplicationContext
import java.util.concurrent.TimeUnit
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Scheduler for managing background sync operations.
 *
 * This class provides methods to schedule periodic background sync and
 * trigger immediate one-time sync operations. It integrates with
 * [ConnectivityMonitor] to automatically trigger sync when connectivity
 * is restored.
 *
 * Sync scheduling:
 * - Periodic sync runs every 15 minutes when network is available
 * - Immediate sync can be triggered manually or when connectivity is restored
 * - All sync work requires network connectivity (won't run when offline)
 *
 * Usage:
 * ```kotlin
 * // Initialize in Application.onCreate()
 * syncScheduler.initialize()
 *
 * // Trigger immediate sync (e.g., on pull-to-refresh)
 * syncScheduler.triggerImmediateSync()
 *
 * // Cancel all sync work (e.g., on logout)
 * syncScheduler.cancelAllSync()
 * ```
 */
@Singleton
class SyncScheduler
    @Inject
    constructor(
        @ApplicationContext private val context: Context,
        private val connectivityMonitor: ConnectivityMonitor,
    ) {
        companion object {
            private const val TAG = "SyncScheduler"

            /**
             * Interval for periodic sync in minutes.
             */
            private const val PERIODIC_SYNC_INTERVAL_MINUTES = 15L

            /**
             * Initial backoff delay for retry in minutes.
             */
            private const val BACKOFF_DELAY_MINUTES = 1L

            /**
             * Unique work name for immediate sync.
             */
            private const val IMMEDIATE_SYNC_WORK_NAME = "immediate_sync"
        }

        private val workManager: WorkManager by lazy {
            WorkManager.getInstance(context)
        }

        /**
         * Initializes the sync scheduler.
         *
         * This sets up:
         * 1. Periodic sync work that runs every 15 minutes
         * 2. Connectivity restoration callback to trigger immediate sync
         *
         * Should be called once in Application.onCreate() after Hilt injection.
         */
        fun initialize() {
            Log.d(TAG, "Initializing sync scheduler")

            // Schedule periodic sync
            schedulePeriodicSync()

            // Set up connectivity-triggered sync
            connectivityMonitor.setOnConnectivityRestoredCallback {
                Log.d(TAG, "Connectivity restored callback triggered")
                triggerImmediateSync()
            }
        }

        /**
         * Schedules periodic background sync.
         *
         * Creates a periodic work request that runs every 15 minutes with:
         * - Network connectivity constraint
         * - Exponential backoff for retries
         * - KEEP policy to avoid rescheduling if already scheduled
         */
        fun schedulePeriodicSync() {
            Log.d(TAG, "Scheduling periodic sync every $PERIODIC_SYNC_INTERVAL_MINUTES minutes")

            val constraints =
                Constraints
                    .Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()

            val periodicSyncRequest =
                PeriodicWorkRequestBuilder<SyncWorker>(
                    repeatInterval = PERIODIC_SYNC_INTERVAL_MINUTES,
                    repeatIntervalTimeUnit = TimeUnit.MINUTES,
                ).setConstraints(constraints)
                    .setBackoffCriteria(
                        backoffPolicy = BackoffPolicy.EXPONENTIAL,
                        backoffDelay = BACKOFF_DELAY_MINUTES,
                        timeUnit = TimeUnit.MINUTES,
                    ).addTag(SyncWorker.PERIODIC_SYNC_WORK_NAME)
                    .build()

            workManager.enqueueUniquePeriodicWork(
                SyncWorker.PERIODIC_SYNC_WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                periodicSyncRequest,
            )

            Log.d(TAG, "Periodic sync scheduled")
        }

        /**
         * Triggers an immediate one-time sync.
         *
         * Creates a one-time work request to sync immediately. The work will
         * only run if network connectivity is available. Uses REPLACE policy
         * to cancel any pending immediate sync before starting a new one.
         *
         * Use cases:
         * - Pull-to-refresh
         * - Connectivity restored
         * - App launch/resume
         */
        fun triggerImmediateSync() {
            Log.d(TAG, "Triggering immediate sync")

            val constraints =
                Constraints
                    .Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()

            val immediateSyncRequest =
                OneTimeWorkRequestBuilder<SyncWorker>()
                    .setConstraints(constraints)
                    .setBackoffCriteria(
                        backoffPolicy = BackoffPolicy.EXPONENTIAL,
                        backoffDelay = BACKOFF_DELAY_MINUTES,
                        timeUnit = TimeUnit.MINUTES,
                    ).addTag(SyncWorker.IMMEDIATE_SYNC_TAG)
                    .build()

            workManager.enqueueUniqueWork(
                IMMEDIATE_SYNC_WORK_NAME,
                ExistingWorkPolicy.REPLACE,
                immediateSyncRequest,
            )

            Log.d(TAG, "Immediate sync enqueued")
        }

        /**
         * Cancels all scheduled sync work.
         *
         * Call this when the user logs out to stop background sync.
         * Also clears the connectivity restoration callback.
         */
        fun cancelAllSync() {
            Log.d(TAG, "Cancelling all sync work")

            // Cancel periodic sync
            workManager.cancelUniqueWork(SyncWorker.PERIODIC_SYNC_WORK_NAME)

            // Cancel any pending immediate sync
            workManager.cancelUniqueWork(IMMEDIATE_SYNC_WORK_NAME)

            // Clear connectivity callback
            connectivityMonitor.setOnConnectivityRestoredCallback(null)

            Log.d(TAG, "All sync work cancelled")
        }

        /**
         * Re-enables sync scheduling.
         *
         * Call this after the user logs in to resume background sync.
         * This re-schedules periodic sync and re-enables connectivity callbacks.
         */
        fun enableSync() {
            Log.d(TAG, "Enabling sync")
            initialize()
        }

        /**
         * Checks if periodic sync is currently scheduled.
         *
         * @return true if periodic sync work is scheduled
         */
        suspend fun isPeriodicSyncScheduled(): Boolean =
            try {
                val workInfo =
                    workManager
                        .getWorkInfosForUniqueWork(SyncWorker.PERIODIC_SYNC_WORK_NAME)
                        .get()

                workInfo.any { !it.state.isFinished }
            } catch (e: Exception) {
                Log.e(TAG, "Error checking periodic sync status", e)
                false
            }
    }
