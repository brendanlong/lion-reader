package com.lionreader.shared.api

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/** Subscription events carry the subscription's `row`, beside the fields older servers sent. */
class SubscriptionEventDecodingTest {
    private fun decode(json: String): SyncEvent? =
        parseSyncEvent(Json.parseToJsonElement(json) as JsonObject)

    private val row =
        """{"id": "sub-1", "type": "web", "url": "https://example.com/feed.xml",
            "title": "Mine", "originalTitle": "Theirs", "description": null, "siteUrl": null,
            "subscribedAt": "2026-10-01T12:00:00.000Z", "unreadCount": 2,
            "unreadCountAsOf": "2026-10-01T12:00:00.000000Z",
            "tags": [{"id": "tag-1", "name": "Tech", "color": null}],
            "fetchFullContent": false}"""

    private val expected =
        Subscription(
            "sub-1",
            type = "web",
            url = "https://example.com/feed.xml",
            title = "Mine",
            originalTitle = "Theirs",
            tags = listOf(TagRef("tag-1", "Tech")),
        )

    @Test
    fun createdUsesItsRow() {
        val event =
            decode(
                """{"type": "subscription_created", "subscriptionId": "sub-1",
                    "timestamp": "2026-10-01T12:00:00.000Z", "updatedAt": "2026-10-01T12:00:00.000Z",
                    "row": $row,
                    "subscription": {"id": "sub-1", "customTitle": "Mine", "tags": [],
                        "subscribedAt": "2026-10-01T12:00:00.000Z", "unreadCount": 2},
                    "feed": {"type": "web", "url": null, "title": "Theirs", "description": null,
                        "siteUrl": null}}"""
            )
                as SyncEvent.SubscriptionCreated

        assertEquals(expected, event.subscriptionRow)
    }

    @Test
    fun createdFromAServerWithoutTheRow() {
        val event =
            decode(
                """{"type": "subscription_created", "subscriptionId": "sub-1",
                    "subscription": {"id": "sub-1", "customTitle": "Mine",
                        "tags": [{"id": "tag-1", "name": "Tech", "color": null}]},
                    "feed": {"type": "web", "url": "https://example.com/feed.xml",
                        "title": "Theirs"}}"""
            )
                as SyncEvent.SubscriptionCreated

        assertEquals(expected, event.subscriptionRow)
    }

    @Test
    fun updatedCarriesItsRow() {
        val event =
            decode(
                """{"type": "subscription_updated", "subscriptionId": "sub-1", "row": $row,
                    "tags": [], "customTitle": "Mine"}"""
            )
                as SyncEvent.SubscriptionUpdated

        assertEquals(expected, event.row)
    }
}
