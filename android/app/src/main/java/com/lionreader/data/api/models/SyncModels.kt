package com.lionreader.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Type of feed for sync responses.
 *
 * The sync API uses a simplified type enum compared to EntryType.
 */
@Serializable
enum class SyncFeedType {
    @SerialName("web")
    WEB,

    @SerialName("email")
    EMAIL,

    @SerialName("saved")
    SAVED,
}

/**
 * Entry data from the sync API (lightweight, no content).
 */
@Serializable
data class SyncEntryDto(
    val id: String,
    @SerialName("feedId")
    val feedId: String,
    val type: SyncFeedType,
    val url: String? = null,
    val title: String? = null,
    val author: String? = null,
    val summary: String? = null,
    @SerialName("publishedAt")
    val publishedAt: String? = null, // ISO 8601
    @SerialName("fetchedAt")
    val fetchedAt: String,
    val read: Boolean = false,
    val starred: Boolean = false,
    @SerialName("feedTitle")
    val feedTitle: String? = null,
    @SerialName("siteName")
    val siteName: String? = null,
)

/**
 * Entry state update from the sync API (read/starred changes only).
 */
@Serializable
data class SyncEntryStateDto(
    val id: String,
    val read: Boolean,
    val starred: Boolean,
)

/**
 * Subscription data from the sync API.
 */
@Serializable
data class SyncSubscriptionDto(
    val id: String,
    @SerialName("feedId")
    val feedId: String,
    @SerialName("feedTitle")
    val feedTitle: String? = null,
    @SerialName("feedUrl")
    val feedUrl: String? = null,
    @SerialName("feedType")
    val feedType: SyncFeedType,
    @SerialName("customTitle")
    val customTitle: String? = null,
    @SerialName("subscribedAt")
    val subscribedAt: String, // ISO 8601
)

/**
 * Tag data from the sync API.
 */
@Serializable
data class SyncTagDto(
    val id: String,
    val name: String,
    val color: String? = null,
)

/**
 * Changes to entries from the sync API.
 */
@Serializable
data class SyncEntriesChanges(
    val created: List<SyncEntryDto>,
    val updated: List<SyncEntryStateDto>,
    val removed: List<String>,
)

/**
 * Changes to subscriptions from the sync API.
 */
@Serializable
data class SyncSubscriptionsChanges(
    val created: List<SyncSubscriptionDto>,
    val removed: List<String>,
)

/**
 * Changes to tags from the sync API.
 */
@Serializable
data class SyncTagsChanges(
    val created: List<SyncTagDto>,
    val removed: List<String>,
)

/**
 * Response from the sync.changes endpoint.
 *
 * Returns all changes since a given timestamp (or recent data for initial sync).
 */
@Serializable
data class SyncChangesResponse(
    val entries: SyncEntriesChanges,
    val subscriptions: SyncSubscriptionsChanges,
    val tags: SyncTagsChanges,
    @SerialName("syncedAt")
    val syncedAt: String, // ISO 8601 - use as next 'since' value
    @SerialName("hasMore")
    val hasMore: Boolean,
)
