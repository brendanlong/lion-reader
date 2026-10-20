package com.lionreader.app.share

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.lionreader.shared.links.uploadFilename
import java.io.File
import java.io.IOException
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * The most of a shared file the app reads. Only bounds the app's own memory (the upload is sent in
 * one request); the server's limit is lower and it says so when a file is over it.
 */
private const val MAX_SHARED_FILE_BYTES = 32L * 1024 * 1024

/** Copies older than this belong to saves that were cancelled, and are deleted. */
private val ABANDONED_AFTER_MILLIS = TimeUnit.DAYS.toMillis(30)

/** A shared file copied into app storage, so a background save can read it later. */
data class CopiedFile(val path: String, val filename: String)

sealed interface CopyResult {
    data class Copied(val file: CopiedFile) : CopyResult

    data class Failed(val message: String) : CopyResult
}

/**
 * Copies a file another app shared. The read grant on [uri] lasts only as long as the share dialog,
 * and a save can wait days for a network, so the save job reads the copy instead. Blocking IO: call
 * it off the main thread.
 */
fun copySharedFile(context: Context, uri: Uri, mimeType: String?): CopyResult {
    val resolver = context.contentResolver
    val displayName =
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        } catch (_: Exception) {
            null
        }
    val filename =
        uploadFilename(displayName, mimeType ?: resolver.getType(uri))
            ?: return CopyResult.Failed(
                "Lion Reader can save PDFs, Word documents, and HTML, Markdown, and text files."
            )

    val dir = sharedFilesDir(context)
    deleteAbandoned(dir)
    val copy = File(dir, UUID.randomUUID().toString())
    return try {
        val input = resolver.openInputStream(uri) ?: throw IOException("No stream")
        var tooLarge = false
        input.use { source ->
            copy.outputStream().use { sink ->
                val buffer = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val read = source.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > MAX_SHARED_FILE_BYTES) {
                        tooLarge = true
                        break
                    }
                    sink.write(buffer, 0, read)
                }
            }
        }
        if (tooLarge) {
            copy.delete()
            CopyResult.Failed("That file is too large to save.")
        } else {
            CopyResult.Copied(CopiedFile(copy.path, filename))
        }
    } catch (_: Exception) {
        copy.delete()
        CopyResult.Failed("Lion Reader couldn't read the shared file.")
    }
}

private fun sharedFilesDir(context: Context): File =
    File(context.filesDir, "shared-files").apply { mkdirs() }

private fun deleteAbandoned(dir: File) {
    val cutoff = System.currentTimeMillis() - ABANDONED_AFTER_MILLIS
    dir.listFiles()?.filter { it.lastModified() < cutoff }?.forEach { it.delete() }
}
