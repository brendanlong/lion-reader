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

        /** Returns the job's id, to follow it by. */
        fun enqueue(context: Context, url: String): UUID =
            enqueue(context, workName(url), workDataOf(URL to url), ExistingWorkPolicy.REPLACE)

        /** The unique work name for saving the shared file copied to [copy] ([sharedFileCopy]). */
        private fun workName(copy: File) = "save-file:${copy.path}"

        /**
         * The work name of a save of [copy] that hasn't finished, if there is one. Blocking: call
         * it off the main thread.
         */
        fun pendingFileSave(context: Context, copy: File): String? {
            val name = workName(copy)
            val infos = WorkManager.getInstance(context).getWorkInfosForUniqueWork(name).get()
            return name.takeIf { infos.any { !it.state.isFinished } }
        }

        /**
         * Queues the upload of [file] and returns its work name. A save of the same copy that's
         * already queued is kept: unlike a URL's, an upload isn't idempotent.
         */
        fun enqueue(context: Context, file: CopiedFile): String {
            val name = workName(File(file.path))
            enqueue(
                context,
                name,
                workDataOf(FILE to file.path, FILENAME to file.filename),
                ExistingWorkPolicy.KEEP,
            )
            return name
        }

        private fun enqueue(
            context: Context,
            name: String,
            input: Data,
            policy: ExistingWorkPolicy,
        ): UUID {
            val request =
                OneTimeWorkRequestBuilder<SaveWorker>()
                    .setConstraints(
                        Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()
                    )
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                    .setInputData(input)
                    .build()
            WorkManager.getInstance(context).enqueueUniqueWork(name, policy, request)
            return request.id
        }
    }
}
