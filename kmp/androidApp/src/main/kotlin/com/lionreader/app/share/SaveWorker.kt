package com.lionreader.app.share

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.lionreader.app.SyncScheduler
import com.lionreader.app.graph
import com.lionreader.shared.account.SaveOutcome
import com.lionreader.shared.account.saveLink
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Saves a shared link in the background ([saveLink]), so it survives the share dialog closing and
 * waits for a network when offline, however long that takes; retries back off to every few hours.
 * The dialog follows its progress by the unique work name.
 */
class SaveWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val url = inputData.getString(URL) ?: return Result.failure()
        return when (
            val outcome = applicationContext.graph.accounts.connection.value.saveLink(url)
        ) {
            is SaveOutcome.Saved -> {
                // Bring the new article onto the device.
                SyncScheduler.syncNow(applicationContext)
                Result.success(workDataOf(TITLE to outcome.title))
            }
            SaveOutcome.Retry -> Result.retry()
            is SaveOutcome.Failed -> Result.failure(workDataOf(ERROR to outcome.message))
        }
    }

    companion object {
        const val TITLE = "title"
        const val ERROR = "error"
        private const val URL = "url"

        /**
         * The unique work name for saving [url]. Sharing it again replaces a pending save (so it
         * runs now rather than after its backoff); saving is idempotent per URL.
         */
        fun workName(url: String) = "save:$url"

        /** Returns the job's id, to follow it by. */
        fun enqueue(context: Context, url: String): UUID {
            val request =
                OneTimeWorkRequestBuilder<SaveWorker>()
                    .setConstraints(
                        Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                    )
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                    .setInputData(workDataOf(URL to url))
                    .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork(workName(url), ExistingWorkPolicy.REPLACE, request)
            return request.id
        }
    }
}
