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
 * Subscription data from the API (without nested feed).
 */
@Serializable
data class SubscriptionDto(
    val id: String,
    @SerialName("feedId")
    val feedId: String,
    @SerialName("customTitle")
    val customTitle: String? = null,
    @SerialName("subscribedAt")
    val subscribedAt: String,
    @SerialName("unreadCount")
    val unreadCount: Int = 0,
    val tags: List<SubscriptionTagDto> = emptyList(),
)

/**
 * Subscription with its feed from the API.
 * Server returns subscription and feed as sibling objects.
 */
@Serializable
data class SubscriptionWithFeedDto(
    val subscription: SubscriptionDto,
    val feed: FeedDto,
)

/**
 * Response from list subscriptions endpoint.
 */
@Serializable
data class SubscriptionsResponse(
    val items: List<SubscriptionWithFeedDto>,
)
