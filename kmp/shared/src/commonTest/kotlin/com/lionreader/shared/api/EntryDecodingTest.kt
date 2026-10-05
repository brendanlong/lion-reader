package com.lionreader.shared.api

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * The server drops entries' `feedId` once no install reads it (#1846); installed apps must keep
 * decoding entries without one.
 */
class EntryDecodingTest {
    @Test
    fun entriesDecodeWithoutAFeedId() {
        val page =
            ApiJson.decodeFromString(
                EntryListPage.serializer(),
                """{"items": [{"id": "a", "type": "web", "fetchedAt": "2026-09-29T12:00:00Z",
                    "read": false, "starred": false}]}""",
            )
        val entries =
            ApiJson.decodeFromString(
                GetManyResponse.serializer(),
                """{"entries": [{"id": "b", "feedId": null, "type": "web",
                    "fetchedAt": "2026-09-29T12:00:00Z", "read": true, "starred": false,
                    "fetchFullContent": false}]}""",
            )

        assertEquals("a", page.items.single().id)
        assertEquals("b", entries.entries.single().id)
    }
}
