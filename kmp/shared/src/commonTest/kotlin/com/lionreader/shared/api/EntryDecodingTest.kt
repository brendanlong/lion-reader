package com.lionreader.shared.api

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * Responses the server may send once it drops what only old installs read (#1846): an entry type
 * this app doesn't know, no `feedId`, and events without `feedType`. Installed apps must keep
 * decoding them.
 */
class EntryDecodingTest {
    @Test
    fun entriesDecodeWithAnUnknownTypeAndWithoutAFeedId() {
        val page =
            ApiJson.decodeFromString(
                EntryListPage.serializer(),
                """{"items": [{"id": "a", "subscriptionId": "sub-1", "type": "podcast",
                    "fetchedAt": "2026-09-29T12:00:00Z", "read": false, "starred": false}]}""",
            )
        val entries =
            ApiJson.decodeFromString(
                GetManyResponse.serializer(),
                """{"entries": [{"id": "b", "feedId": null, "type": "collection",
                    "fetchedAt": "2026-09-29T12:00:00Z", "read": true, "starred": false,
                    "fetchFullContent": false}]}""",
            )

        assertEquals("podcast", page.items.single().type)
        assertEquals("collection", entries.entries.single().type)
    }

    @Test
    fun entryEventsParseWithoutAFeedType() {
        val newEntry =
            parseSyncEvent(
                event(
                    """{"type": "new_entry", "entryId": "a",
                        "entry": {"type": "saved", "fetchedAt": "2026-09-29T12:00:00Z"}}"""
                )
            )
        val stateChanged =
            parseSyncEvent(
                event(
                    """{"type": "entry_state_changed", "entryId": "b", "read": false,
                        "starred": false, "entry": {"fetchedAt": "2026-09-29T12:00:00Z"}}"""
                )
            )

        // The type comes from the entry when the event doesn't carry it.
        assertEquals("saved", assertIs<SyncEvent.NewEntry>(newEntry).entryType)
        assertNull(assertIs<SyncEvent.EntryStateChanged>(stateChanged).entryType)
    }

    private fun event(json: String) = Json.decodeFromString(JsonObject.serializer(), json)
}
