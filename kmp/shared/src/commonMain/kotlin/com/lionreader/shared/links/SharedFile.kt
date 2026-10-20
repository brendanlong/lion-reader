package com.lionreader.shared.links

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
    )

/**
 * The name to upload a shared file under, since the server picks its converter by extension: the
 * file's own [displayName] when that has an extension the server converts, else the name with its
 * [mimeType]'s extension added. Null when neither says it's a type the server converts.
 */
fun uploadFilename(displayName: String?, mimeType: String?): String? {
    val name = displayName?.trim()?.takeIf { it.isNotEmpty() } ?: "Shared file"
    if (UPLOAD_EXTENSIONS.any { name.endsWith(it, ignoreCase = true) }) return name
    val mediaType = mimeType?.substringBefore(';')?.trim()?.lowercase()
    val extension = EXTENSION_BY_MIME_TYPE[mediaType]?.takeIf { it in UPLOAD_EXTENSIONS }
    return extension?.let { name + it }
}
