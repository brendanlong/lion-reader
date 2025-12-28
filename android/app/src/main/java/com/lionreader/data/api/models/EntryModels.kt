package com.lionreader.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

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
enum class SortOrder(val value: String) {
    NEWEST("newest"),
    OLDEST("oldest"),
}
