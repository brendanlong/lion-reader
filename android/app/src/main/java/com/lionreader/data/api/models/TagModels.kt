package com.lionreader.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Tag data from the API.
 */
@Serializable
data class TagDto(
    val id: String,
    val name: String,
    val color: String? = null, // hex color like "#ff6b6b"
    @SerialName("feedCount")
    val feedCount: Int = 0,
)

/**
 * Response from list tags endpoint.
 */
@Serializable
data class TagsResponse(
    val tags: List<TagDto>,
)
