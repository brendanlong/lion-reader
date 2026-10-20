package com.lionreader.shared.api

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * Entries and their state events carry the user's score and the entry's collection positions
 * (#2064); a server a release behind sends neither, which isn't the same as clearing them.
 */
class RankingsDecodingTest {
    private fun stateChanged(rankings: String): SyncEvent.EntryStateChanged =
        parseSyncEvent(
            Json.parseToJsonElement(
                """{"type": "entry_state_changed", "entryId": "a", "read": false,
                    "starred": false, "subscriptionIds": ["sub-1", "col-1"],
                    "timestamp": "2026-10-20T12:00:00.000Z"$rankings}"""
            ) as JsonObject
        )
            as SyncEvent.EntryStateChanged

    @Test
    fun stateEventsCarryScoreAndPositions() {
        assertEquals(
            Rankings(2.5, mapOf("col-1" to 3.0)),
            stateChanged(""", "score": 2.5, "positions": {"col-1": 3}""").rankings,
        )
        // Cleared: none left.
        assertEquals(
            Rankings(null, emptyMap()),
            stateChanged(""", "score": null, "positions": {}""").rankings,
        )
        assertNull(stateChanged("").rankings)
    }

    @Test
    fun entriesCarryScoreAndPositions() {
        val item =
            ApiJson.decodeFromString(
                EntryListPage.serializer(),
                """{"items": [{"id": "a", "subscriptionIds": ["col-1"], "type": "web",
                    "fetchedAt": "2026-10-20T12:00:00Z", "read": false, "starred": false,
                    "score": -1, "positions": {"col-1": 0.5}}],
                    "sortable": {"score": true, "position": true}}""",
            )
        val full =
            ApiJson.decodeFromString(
                GetManyResponse.serializer(),
                """{"entries": [{"id": "b", "subscriptionIds": [], "type": "web",
                    "fetchedAt": "2026-10-20T12:00:00Z", "read": true, "starred": false,
                    "content": null}]}""",
            )

        assertEquals(Rankings(-1.0, mapOf("col-1" to 0.5)), item.items.single().rankings)
        assertNull(full.entries.single().rankings)
    }
}
