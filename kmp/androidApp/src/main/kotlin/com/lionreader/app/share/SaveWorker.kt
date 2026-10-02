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
import com.lionreader.shared.api.ApiException
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException

/**
 * Saves a shared link in the background, so it survives the share dialog closing and waits for a
 * network when offline, however long that takes. It only gives up when the server rejects the link
 * (or the user signs out); anything else retries, backing off to every few hours. The dialog
 * follows its progress by the unique work name.
 */
class SaveWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val url = inputData.getString(URL) ?: return Result.failure()
        val connection = applicationContext.graph.connection.value
        if (!connection.auth.signedIn.value) {
            return failure("Sign in to Lion Reader to save links.")
        }
        return try {
            val saved = connection.api.saveArticle(url)
            // Bring the new article onto the device.
            SyncScheduler.syncNow(applicationContext)
            Result.success(workDataOf(TITLE to saved.title))
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            when {
                e.status == 0 -> failure("Sign in to Lion Reader to save links.")
                // Any other 4xx but 429 is the server's answer: a 401 here came
                // back after a token refresh, so it isn't about the token.
                e.isPermanent || (e.status in 400..499 && e.status != 429) ->
                    failure(e.serverMessage ?: "Lion Reader couldn't save this link.")
                else -> Result.retry()
            }
        } catch (e: Exception) {
            // Network, token endpoint, unexpected responses: try again later
            // (saving a URL twice just updates the article).
            Result.retry()
        }
    }

    private fun failure(message: String) = Result.failure(workDataOf(ERROR to message))

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
