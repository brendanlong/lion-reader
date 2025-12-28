package com.lionreader.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Feed data from the API.
 */
@Serializable
data class FeedDto(
    val id: String,
    val type: String, // "rss", "atom", "json"
    val url: String? = null,
    val title: String? = null,
    val description: String? = null,
    @SerialName("siteUrl")
    val siteUrl: String? = null,
)

/**
 * Tag reference within a subscription.
 */
@Serializable
data class SubscriptionTagDto(
    val id: String,
    val name: String,
    val color: String? = null,
)

/**
 * Subscription data from the API.
 */
@Serializable
data class SubscriptionDto(
    val id: String,
    @SerialName("feedId")
    val feedId: String,
    val feed: FeedDto,
    @SerialName("customTitle")
    val customTitle: String? = null,
    @SerialName("subscribedAt")
    val subscribedAt: String,
    @SerialName("unreadCount")
    val unreadCount: Int = 0,
    val tags: List<SubscriptionTagDto> = emptyList(),
)

/**
 * Response from list subscriptions endpoint.
 */
@Serializable
data class SubscriptionsResponse(
    val subscriptions: List<SubscriptionDto>,
)
