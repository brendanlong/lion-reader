package com.lionreader.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Full saved article data returned by the save endpoint.
 * Note: For listing and getting saved articles, use the unified entries endpoints
 * which return [EntryListItemDto] and [EntryFullDto] respectively.
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
 * Response from the save URL endpoint.
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
