package com.lionreader.shared.links

import com.lionreader.shared.api.EBOOK_UPLOAD_EXTENSIONS
import com.lionreader.shared.api.UPLOAD_EXTENSIONS

/** The extension for a MIME type another app shares a file as, for files named without one. */
private val EXTENSION_BY_MIME_TYPE =
    mapOf(
        "application/pdf" to ".pdf",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" to ".docx",
        "text/html" to ".html",
        "text/markdown" to ".md",
        "text/x-markdown" to ".md",
        "text/plain" to ".txt",
        "application/epub+zip" to ".epub",
    )

/** What the server takes: a file it converts to an article, or an ebook it imports. */
private val ACCEPTED_EXTENSIONS = UPLOAD_EXTENSIONS + EBOOK_UPLOAD_EXTENSIONS

/** Whether [filename] is an ebook, which imports as a collection rather than one article. */
fun isEbookFilename(filename: String): Boolean = EBOOK_UPLOAD_EXTENSIONS.any {
    filename.endsWith(it, ignoreCase = true)
}

/**
 * Longest upload name kept, extension included: a provider's name can be any length, and it's
 * handed to a background job (WorkManager input is limited to 10 KB) and shown as the title.
 */
const val MAX_UPLOAD_FILENAME_CHARS = 200

/**
 * The name to upload a shared file under, since the server picks its converter by extension: the
 * file's own [displayName] when that has an extension the server converts or imports, else the name
 * with its [mimeType]'s extension added, shortened to [MAX_UPLOAD_FILENAME_CHARS]. Null when
 * neither says it's a type the server takes.
 */
fun uploadFilename(displayName: String?, mimeType: String?): String? {
    val name = displayName?.trim()?.takeIf { it.isNotEmpty() } ?: "Shared file"
    val own = ACCEPTED_EXTENSIONS.firstOrNull { name.endsWith(it, ignoreCase = true) }
    val stem = if (own != null) name.dropLast(own.length) else name
    val extension =
        if (own != null) name.takeLast(own.length)
        else {
            val mediaType = mimeType?.substringBefore(';')?.trim()?.lowercase()
            EXTENSION_BY_MIME_TYPE[mediaType]?.takeIf { it in ACCEPTED_EXTENSIONS } ?: return null
        }
    return stem.take(MAX_UPLOAD_FILENAME_CHARS - extension.length) + extension
}
