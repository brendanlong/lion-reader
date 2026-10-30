package com.lionreader.app.share

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.lionreader.shared.api.ServerLimits
import com.lionreader.shared.links.ACCEPTED_UPLOAD_EXTENSIONS
import com.lionreader.shared.links.isEbookFilename
import com.lionreader.shared.links.uploadFilename
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/**
 * Copies this old are deleted: left by the app dying mid-copy, or by a save still waiting for a
 * network after a month, which then fails saying the file is gone.
 */
private val ABANDONED_AFTER_MILLIS = TimeUnit.DAYS.toMillis(30)

internal fun sharedFilesDir(context: Context) = File(context.filesDir, "shared-files")

/** Deletes every copy, when their saves are cancelled (signing out). */
fun deleteSharedFileCopies(context: Context) {
    sharedFilesDir(context).deleteRecursively()
}

sealed interface OpenResult

sealed interface CopyResult

data class ShareFailed(val message: String) : OpenResult, CopyResult

/** A shared file, opened while the share's read grant lasted, for [copySharedFile] to read. */
class SharedStream(val input: InputStream, val filename: String) : OpenResult

/**
 * A shared file copied into app storage, so a background save can read it later. Its name is a hash
 * of its upload [filename] and bytes, which is also its upload's idempotency key: the same file
 * shared again (or the dialog recreated after process death) is the same save, and a different file
 * is a different save even when the sending app shares every file from the same URI. The filename
 * is in it because it picks the converter: the same text as `.txt` and as `.md` differs.
 */
data class CopiedFile(val path: String, val filename: String) : CopyResult

/**
 * Opens a file another app shared, and decides the name to upload it under. The read grant on [uri]
 * lasts only as long as the share dialog, so the dialog stays until this returns; once open, the
 * stream can be read after the dialog is gone. Blocking IO: call it off the main thread.
 *
 * Only another app's `content://` URI is read: the share target is exported, and a `file://` or our
 * own provider's URI would read the app's private files (its tokens) with its own permissions and
 * upload them.
 */
fun openSharedFile(context: Context, uri: Uri, sharedType: String?): OpenResult {
    if (!isAnotherAppsContent(context, uri)) {
        return ShareFailed("Lion Reader can only save files shared by another app.")
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
            ?: return ShareFailed(
                "Lion Reader can save only these kinds of file: " +
                    ACCEPTED_UPLOAD_EXTENSIONS.joinToString(", ") +
                    "."
            )
    val input =
        try {
            resolver.openInputStream(uri)
        } catch (_: Exception) {
            null
        } ?: return ShareFailed(COULD_NOT_READ)
    return SharedStream(input, filename)
}

/**
 * Copies [shared] into app storage ([CopiedFile]), closing it: a save can wait days for a network,
 * so the save job reads the copy. Blocking IO: call it off the main thread.
 */
fun copySharedFile(context: Context, shared: SharedStream): CopyResult {
    val maxBytes =
        if (isEbookFilename(shared.filename)) ServerLimits.EBOOK_UPLOAD_BYTES
        else ServerLimits.UPLOAD_BYTES
    val dir = sharedFilesDir(context).apply { mkdirs() }
    deleteAbandoned(context)
    // Written aside and renamed into place, so an upload reading an earlier copy of the same file
    // never sees it half written.
    var partial: File? = null
    return try {
        val written = File.createTempFile("copy", ".partial", dir).also { partial = it }
        val digest = MessageDigest.getInstance("SHA-256")
        // Ended by a 0, which no filename holds, so where it ends can't be shifted into the bytes.
        digest.update(shared.filename.encodeToByteArray())
        digest.update(0)
        var tooLarge = false
        shared.input.use { source ->
            written.outputStream().use { sink ->
                val buffer = ByteArray(64 * 1024)
                var total = 0L
                while (true) {
                    val read = source.read(buffer)
                    if (read < 0) break
                    total += read
                    if (total > maxBytes) {
                        tooLarge = true
                        break
                    }
                    digest.update(buffer, 0, read)
                    sink.write(buffer, 0, read)
                }
            }
        }
        val copy = File(dir, digest.digest().joinToString("") { "%02x".format(it) })
        if (tooLarge) {
            written.delete()
            ShareFailed("That file is too large to save.")
        } else if (!written.renameTo(copy)) {
            throw IOException("Couldn't rename the copy")
        } else {
            CopiedFile(copy.path, shared.filename)
        }
    } catch (_: Exception) {
        shared.input.close()
        partial?.delete()
        ShareFailed(COULD_NOT_READ)
    }
}

private const val COULD_NOT_READ = "Lion Reader couldn't read the shared file."

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
