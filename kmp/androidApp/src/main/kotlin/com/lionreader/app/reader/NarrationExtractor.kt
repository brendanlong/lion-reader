package com.lionreader.app.reader

import android.content.Context
import android.webkit.WebView
import com.lionreader.app.AppSettings
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

/**
 * The paragraphs narration speaks for an article that isn't on screen (the next one, for continuous
 * playback). Only the reader's narration script extracts them, so it runs in an off-screen WebView
 * set up like the reader's. Main thread.
 */
class NarrationExtractor(private val context: Context) {
    private val tokens by lazy { AppearanceTokens.load(context) }

    /** Null when the page doesn't report them in time. */
    suspend fun paragraphs(title: String, body: String): List<String>? {
        val document =
            readerDocument(
                ReaderHeader(title, ""),
                summary = null,
                body = body,
                settings = AppSettings(),
                tokens = tokens,
                // Never shown.
                colors = ReaderColors("#000", "#000", "#000", "#fff", "#000", "#fff"),
            )
        val view = WebView(context)
        return try {
            withTimeoutOrNull(TIMEOUT_MILLIS) {
                suspendCancellableCoroutine { continuation ->
                    view.setUpReader { data ->
                        val message = runCatching { JSONObject(data) }.getOrNull()
                        val paragraphs = message?.optJSONArray("paragraphs")
                        if (
                            message?.optString("type") == "narration" &&
                                paragraphs != null &&
                                continuation.isActive
                        ) {
                            continuation.resumeWith(
                                Result.success(
                                    List(paragraphs.length()) { paragraphs.getString(it) }
                                )
                            )
                        }
                    }
                    view.loadDataWithBaseURL("$ASSET_ORIGIN/", document, "text/html", "utf-8", null)
                }
            }
        } finally {
            view.destroy()
        }
    }

    private companion object {
        const val TIMEOUT_MILLIS = 10_000L
    }
}
