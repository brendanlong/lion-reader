package com.lionreader.data.api.models

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

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
 * Subscription data from the API (flat format with merged feed data).
 *
 * The subscription ID is the primary external identifier. Feed IDs are now
 * internal implementation details. All feed metadata is merged into this
 * response for a simpler, flatter API.
 */
@Serializable
data class SubscriptionDto(
    val id: String, // subscription_id is THE id
    val type: String, // "web", "email", "saved"
    val url: String? = null,
    val title: String, // resolved (custom or original)
    @SerialName("originalTitle")
    val originalTitle: String? = null, // feed's original title for rename UI
    val description: String? = null,
    @SerialName("siteUrl")
    val siteUrl: String? = null,
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
    val items: List<SubscriptionDto>,
)
