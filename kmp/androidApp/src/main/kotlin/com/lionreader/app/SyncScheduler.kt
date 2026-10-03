package com.lionreader.app

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.lionreader.shared.account.SyncOutcome
import com.lionreader.shared.account.runBackgroundSync
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers

/**
 * Background sync ([com.lionreader.shared.account.BackgroundSync]) through WorkManager: a periodic
 * full sync, and a quick flush of the outbox after the user acts.
 */
object SyncScheduler {
    private const val PERIODIC = "sync-periodic"
    private const val FLUSH = "sync-flush"
    private const val NOW = "sync-now"

    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    fun schedulePeriodic(context: Context) {
        val request =
            PeriodicWorkRequestBuilder<SyncWorker>(30, TimeUnit.MINUTES)
                .setConstraints(online)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                .build()
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    // A flush already running finishes; one more queues behind it and sends
    // whatever accumulated meanwhile.
    fun flushSoon(context: Context) =
        enqueue(context, FLUSH, fullSync = false, ExistingWorkPolicy.APPEND_OR_REPLACE)

    fun syncNow(context: Context) =
        enqueue(context, NOW, fullSync = true, ExistingWorkPolicy.REPLACE)

    private fun enqueue(
        context: Context,
        name: String,
        fullSync: Boolean,
        policy: ExistingWorkPolicy,
    ) {
        val request =
            OneTimeWorkRequestBuilder<SyncWorker>()
                .setConstraints(online)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .setInputData(workDataOf(FULL_SYNC to fullSync))
                .build()
        WorkManager.getInstance(context).enqueueUniqueWork(name, policy, request)
    }

    fun cancelAll(context: Context) = WorkManager.getInstance(context).cancelAllWork()

    internal const val FULL_SYNC = "full_sync"
}

class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result =
        when (
            applicationContext.graph.accounts.runBackgroundSync(
                full = inputData.getBoolean(SyncScheduler.FULL_SYNC, true),
                io = Dispatchers.IO,
            )
        ) {
            SyncOutcome.DONE -> Result.success()
            SyncOutcome.RETRY -> Result.retry()
            SyncOutcome.FAILED -> Result.failure()
        }
}
