package com.lionreader.app.share

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.lionreader.app.SyncScheduler
import com.lionreader.app.graph
import com.lionreader.shared.account.SaveOutcome
import com.lionreader.shared.account.saveFile
import com.lionreader.shared.account.saveLink
import java.io.File
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Saves a shared link ([saveLink]) or file ([saveFile]) in the background, so it survives the share
 * dialog closing and waits for a network when offline, however long that takes; retries back off to
 * every few hours. The dialog follows its progress by the unique work name.
 */
class SaveWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val connection = applicationContext.graph.accounts.connection.value
        val url = inputData.getString(URL)
        val path = inputData.getString(FILE)
        val outcome =
            when {
                url != null -> connection.saveLink(url)
                path != null -> {
                    val file = File(path)
                    val bytes =
                        withContext(Dispatchers.IO) { file.takeIf { it.exists() }?.readBytes() }
                            ?: return Result.failure(
                                workDataOf(ERROR to "The shared file is no longer available.")
                            )
                    connection.saveFile(inputData.getString(FILENAME) ?: file.name, bytes).also {
                        if (it != SaveOutcome.Retry) withContext(Dispatchers.IO) { file.delete() }
                    }
                }
                else -> return Result.failure()
            }
        return when (outcome) {
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
        private const val FILE = "file"
        private const val FILENAME = "filename"

        /**
         * The unique work name for saving [url]. Sharing it again replaces a pending save (so it
         * runs now rather than after its backoff); saving is idempotent per URL.
         */
        fun workName(url: String) = "save:$url"

        /** The unique work name for saving a [CopiedFile]; each shared file is its own save. */
        fun workName(file: CopiedFile) = "save-file:${file.path}"

        /** Returns the job's id, to follow it by. */
        fun enqueue(context: Context, url: String): UUID =
            enqueue(context, workName(url), workDataOf(URL to url))

        fun enqueue(context: Context, file: CopiedFile): UUID =
            enqueue(
                context,
                workName(file),
                workDataOf(FILE to file.path, FILENAME to file.filename),
            )

        private fun enqueue(context: Context, name: String, input: Data): UUID {
            val request =
                OneTimeWorkRequestBuilder<SaveWorker>()
                    .setConstraints(
                        Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                    )
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                    .setInputData(input)
                    .build()
            WorkManager.getInstance(context)
                .enqueueUniqueWork(name, ExistingWorkPolicy.REPLACE, request)
            return request.id
        }
    }
}
