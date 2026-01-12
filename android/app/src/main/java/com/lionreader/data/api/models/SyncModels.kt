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
 *
 * Note: subscriptionId is the primary external identifier for linking entries
 * to subscriptions. feedId is still present for internal cache invalidation.
 * subscriptionId may be null for orphaned starred entries (from unsubscribed feeds).
 */
@Serializable
data class SyncEntryDto(
    val id: String,
    @SerialName("subscriptionId")
    val subscriptionId: String? = null, // primary external identifier, null for orphaned starred
    @SerialName("feedId")
    val feedId: String, // still present for cache invalidation
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
 * Subscription data from the sync API (flat format with merged feed data).
 *
 * The subscription ID is the primary external identifier. Feed IDs are now
 * internal implementation details. All feed metadata is merged into this
 * response for a simpler, flatter API.
 */
@Serializable
data class SyncSubscriptionDto(
    val id: String, // subscription_id is THE id
    val type: SyncFeedType,
    val url: String? = null,
    val title: String, // resolved (custom or original)
    @SerialName("originalTitle")
    val originalTitle: String? = null, // feed's original title for rename UI
    val description: String? = null,
    @SerialName("siteUrl")
    val siteUrl: String? = null,
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
