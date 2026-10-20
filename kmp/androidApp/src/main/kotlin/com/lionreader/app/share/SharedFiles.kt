package com.lionreader.app.share

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.lionreader.shared.api.ServerLimits
import com.lionreader.shared.links.uploadFilename
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Copies this old are deleted: left by the app dying mid-copy, or by a save still waiting for a
 * network after a month, which then fails saying the file is gone.
 */
private val ABANDONED_AFTER_MILLIS = TimeUnit.DAYS.toMillis(30)

private fun sharedFilesDir(context: Context) = File(context.filesDir, "shared-files")

/** Deletes every copy, when their saves are cancelled (signing out). */
fun deleteSharedFileCopies(context: Context) {
    sharedFilesDir(context).deleteRecursively()
}

/** A shared file copied into app storage, so a background save can read it later. */
data class CopiedFile(val path: String, val filename: String)

sealed interface CopyResult {
    data class Copied(val file: CopiedFile) : CopyResult

    data class Failed(val message: String) : CopyResult
}

/**
 * Where a shared file is copied: named after its URI, so the same share delivered again (the dialog
 * recreated after process death) is the same save. The name is its upload's idempotency key.
 */
fun sharedFileCopy(context: Context, uri: Uri): File {
    val digest = MessageDigest.getInstance("SHA-256").digest(uri.toString().toByteArray())
    val name = digest.take(16).joinToString("") { "%02x".format(it) }
    return File(sharedFilesDir(context).apply { mkdirs() }, name)
}

/**
 * Copies a file another app shared to [sharedFileCopy]. The read grant on [uri] lasts only as long
 * as the share dialog, and a save can wait days for a network, so the save job reads the copy
 * instead. Blocking IO: call it off the main thread.
 *
 * Only another app's `content://` URI is read: the share target is exported, and a `file://` or our
 * own provider's URI would read the app's private files (its tokens) with its own permissions and
 * upload them.
 */
fun copySharedFile(context: Context, uri: Uri, sharedType: String?): CopyResult {
    if (!isAnotherAppsContent(context, uri)) {
        return CopyResult.Failed("Lion Reader can only save files shared by another app.")
    }
    val resolver = context.contentResolver
    // A provider can fail or have its grant revoked at any call; only the stream matters.
    val displayName =
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        } catch (_: Exception) {
            null
        }
    // The provider knows what the file is; the intent's type is the sender's guess (a link share
    // with an image attached says text/plain).
    val providerType =
        try {
            resolver.getType(uri)
        } catch (_: Exception) {
            null
        }
    val filename =
        uploadFilename(displayName, providerType ?: sharedType)
            ?: return CopyResult.Failed(
                "Lion Reader can save PDFs, Word documents, and HTML, Markdown, and text files."
            )

    val copy = sharedFileCopy(context, uri)
    deleteAbandoned(context)
    // Written beside the copy and renamed over it, so an upload reading an earlier copy of the
    // same share never sees it half rewritten.
    val partial = File(copy.path + ".partial")
    return try {
        val input = resolver.openInputStream(uri) ?: throw IOException("No stream")
        var tooLarge = false
        input.use { source ->
            partial.outputStream().use { sink ->
                val buffer = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val read = source.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > ServerLimits.UPLOAD_BYTES) {
                        tooLarge = true
                        break
                    }
                    sink.write(buffer, 0, read)
                }
            }
        }
        if (tooLarge) {
            partial.delete()
            CopyResult.Failed("That file is too large to save.")
        } else if (!partial.renameTo(copy)) {
            throw IOException("Couldn't rename the copy")
        } else {
            CopyResult.Copied(CopiedFile(copy.path, filename))
        }
    } catch (_: Exception) {
        partial.delete()
        CopyResult.Failed("Lion Reader couldn't read the shared file.")
    }
}

private fun isAnotherAppsContent(context: Context, uri: Uri): Boolean {
    if (uri.scheme != ContentResolver.SCHEME_CONTENT) return false
    val authority = uri.authority ?: return false
    val provider = context.packageManager.resolveContentProvider(authority, 0)
    return provider != null && provider.packageName != context.packageName
}

private fun deleteAbandoned(context: Context) {
    val cutoff = System.currentTimeMillis() - ABANDONED_AFTER_MILLIS
    sharedFilesDir(context)
        .listFiles()
        ?.filter { it.lastModified() < cutoff }
        ?.forEach { it.delete() }
}
