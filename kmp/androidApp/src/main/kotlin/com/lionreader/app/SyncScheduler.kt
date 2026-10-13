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
import com.lionreader.shared.settings.SyncInterval
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers

/**
 * Background sync ([com.lionreader.shared.account.BackgroundSync]) through WorkManager: a periodic
 * full sync, and a quick flush of the outbox after the user acts.
 */
object SyncScheduler {
    internal const val PERIODIC = "sync-periodic"
    private const val FLUSH = "sync-flush"
    private const val NOW = "sync-now"

    private val online = constraints(NetworkType.CONNECTED)

    private fun constraints(network: NetworkType) =
        Constraints.Builder().setRequiredNetworkType(network).build()

    /**
     * Every [interval], or not at all, on [wifiOnly] an unmetered network; a change doesn't restart
     * the period.
     */
    fun schedulePeriodic(context: Context, interval: SyncInterval, wifiOnly: Boolean) {
        val workManager = WorkManager.getInstance(context)
        val minutes = interval.minutes ?: return run { workManager.cancelUniqueWork(PERIODIC) }
        val request =
            PeriodicWorkRequestBuilder<SyncWorker>(minutes, TimeUnit.MINUTES)
                .setConstraints(if (wifiOnly) constraints(NetworkType.UNMETERED) else online)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                .build()
        workManager.enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, request)
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
