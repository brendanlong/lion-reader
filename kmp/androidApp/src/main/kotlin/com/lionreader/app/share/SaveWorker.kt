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
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException

/**
 * Saves a shared link in the background, so it survives the share dialog closing and waits for a
 * network when offline. The dialog follows its progress by the unique work name.
 */
class SaveWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val url = inputData.getString(URL) ?: return Result.failure()
        val connection = applicationContext.graph.connection.value
        if (!connection.auth.signedIn.value) {
            return failure("Sign in to Lion Reader to save links.")
        }
        if (runAttemptCount >= MAX_ATTEMPTS) {
            return failure("Lion Reader couldn't save this link. Try sharing it again later.")
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
            // Network, token endpoint, unexpected responses: try again later.
            Result.retry()
        }
    }

    private fun failure(message: String) = Result.failure(workDataOf(ERROR to message))

    companion object {
        const val TITLE = "title"
        const val ERROR = "error"
        private const val URL = "url"
        // About two hours of backoff, then it's the user's call.
        private const val MAX_ATTEMPTS = 8

        /**
         * The unique work name for saving [url]. Sharing it again replaces a pending save (so it
         * runs now rather than after its backoff); saving is idempotent per URL.
         */
        fun workName(url: String) = "save:$url"

        fun enqueue(context: Context, url: String) {
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
        }
    }
}
