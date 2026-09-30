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
        val account = applicationContext.graph.account.value
        if (!applicationContext.graph.connection.value.auth.signedIn.value) {
            return failure("Sign in to Lion Reader to save links.")
        }
        // Signed in, but which account isn't settled yet.
        account ?: return Result.retry()
        return try {
            val saved = account.connection.api.saveArticle(url)
            // Bring the new article onto the device.
            SyncScheduler.syncNow(applicationContext)
            Result.success(workDataOf(TITLE to saved.title))
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            when {
                e.status == 0 -> failure("Sign in to Lion Reader to save links.")
                e.isPermanent -> failure(e.serverMessage ?: "Lion Reader couldn't save this link.")
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

        /** The unique work name for saving [url]; sharing it again while pending is a no-op. */
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
                .enqueueUniqueWork(workName(url), ExistingWorkPolicy.KEEP, request)
        }
    }
}
