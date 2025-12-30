package com.lionreader.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Saved article data from the API (list view, without full content).
 */
@Serializable
data class SavedArticleListItemDto(
    val id: String,
    val url: String,
    val title: String? = null,
    @SerialName("siteName")
    val siteName: String? = null,
    val author: String? = null,
    @SerialName("imageUrl")
    val imageUrl: String? = null,
    val excerpt: String? = null,
    val read: Boolean = false,
    val starred: Boolean = false,
    @SerialName("savedAt")
    val savedAt: String, // ISO 8601
)

/**
 * Full saved article data from the API (includes content).
 */
@Serializable
data class SavedArticleFullDto(
    val id: String,
    val url: String,
    val title: String? = null,
    @SerialName("siteName")
    val siteName: String? = null,
    val author: String? = null,
    @SerialName("imageUrl")
    val imageUrl: String? = null,
    @SerialName("contentOriginal")
    val contentOriginal: String? = null,
    @SerialName("contentCleaned")
    val contentCleaned: String? = null,
    val excerpt: String? = null,
    val read: Boolean = false,
    val starred: Boolean = false,
    @SerialName("savedAt")
    val savedAt: String, // ISO 8601
    @SerialName("readAt")
    val readAt: String? = null,
    @SerialName("starredAt")
    val starredAt: String? = null,
)

/**
 * Response from list saved articles endpoint (paginated).
 */
@Serializable
data class SavedArticlesResponse(
    val items: List<SavedArticleListItemDto>,
    @SerialName("nextCursor")
    val nextCursor: String? = null,
)

/**
 * Response from get single saved article endpoint.
 */
@Serializable
data class SavedArticleResponse(
    val article: SavedArticleFullDto,
)

/**
 * Request body for saving a URL.
 */
@Serializable
data class SaveArticleRequest(
    val url: String,
    val html: String? = null,
    val title: String? = null,
)

/**
 * Request body for marking saved articles as read/unread.
 */
@Serializable
data class SavedMarkReadRequest(
    val ids: List<String>,
    val read: Boolean,
)

/**
 * Response from saved articles count endpoint.
 */
@Serializable
data class SavedCountResponse(
    val total: Int,
    val unread: Int,
)
