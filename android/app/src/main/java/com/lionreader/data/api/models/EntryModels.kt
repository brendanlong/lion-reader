package com.lionreader.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Type of entry (feed format or saved article).
 */
@Serializable
enum class EntryType {
    @SerialName("rss")
    RSS,
    @SerialName("atom")
    ATOM,
    @SerialName("json")
    JSON,
    @SerialName("email")
    EMAIL,
    @SerialName("saved")
    SAVED,
}

/**
 * Entry data from the API.
 */
@Serializable
data class EntryDto(
    val id: String,
    @SerialName("feedId")
    val feedId: String,
    val url: String? = null,
    val title: String? = null,
    val author: String? = null,
    val summary: String? = null,
    @SerialName("contentOriginal")
    val contentOriginal: String? = null,
    @SerialName("contentCleaned")
    val contentCleaned: String? = null,
    @SerialName("publishedAt")
    val publishedAt: String? = null, // ISO 8601
    @SerialName("fetchedAt")
    val fetchedAt: String,
    val read: Boolean = false,
    val starred: Boolean = false,
    @SerialName("feedTitle")
    val feedTitle: String? = null,
    @SerialName("feedUrl")
    val feedUrl: String? = null,
    val type: EntryType,
)

/**
 * Response from list entries endpoint (paginated).
 */
@Serializable
data class EntriesResponse(
    val items: List<EntryDto>,
    @SerialName("nextCursor")
    val nextCursor: String? = null,
)

/**
 * Response from get single entry endpoint.
 */
@Serializable
data class EntryResponse(
    val entry: EntryDto,
)

/**
 * Request body for marking entries as read/unread.
 */
@Serializable
data class MarkReadRequest(
    val ids: List<String>,
    val read: Boolean,
)

/**
 * Sort order for entries.
 */
enum class SortOrder(
    val value: String,
) {
    NEWEST("newest"),
    OLDEST("oldest"),
}

/**
 * Response from starred entries count endpoint.
 */
@Serializable
data class StarredCountResponse(
    val total: Int,
    val unread: Int,
)

/**
 * Response from entries count endpoint.
 */
@Serializable
data class EntriesCountResponse(
    val total: Int,
    val unread: Int,
)
