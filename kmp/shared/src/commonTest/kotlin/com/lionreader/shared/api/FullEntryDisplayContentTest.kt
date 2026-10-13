package com.lionreader.shared.api

import kotlin.test.Test
import kotlin.test.assertEquals

/** [FullEntry.displayContent] must match the web's `showsFullContent` (#1914). */
class FullEntryDisplayContentTest {
    private fun entry(fullContentError: String?): FullEntry =
        ApiJson.decodeFromString(
                GetManyResponse.serializer(),
                """{"entries": [{"id": "a", "type": "web", "fetchedAt": "2026-09-29T12:00:00Z",
                "read": false, "starred": false, "fetchFullContent": true,
                "contentCleaned": "feed", "fullContentCleaned": "full",
                "fullContentError": ${fullContentError?.let { "\"$it\"" } ?: "null"}}]}""",
            )
            .entries
            .single()

    @Test
    fun showsFullContentWhenTheLatestFetchSucceeded() {
        assertEquals("full", entry(fullContentError = null).displayContent)
    }

    @Test
    fun showsFeedContentWhenTheLatestFetchFailed() {
        assertEquals("feed", entry(fullContentError = "HTTP 500").displayContent)
    }
}
