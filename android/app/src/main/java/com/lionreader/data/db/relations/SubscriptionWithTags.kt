package com.lionreader.data.db.relations

import com.lionreader.data.db.entities.TagEntity

/**
 * Data class representing a subscription with its associated tags.
 *
 * Combines subscription + feed data with a list of tags applied to the subscription.
 * Used for displaying subscriptions in the navigation drawer with tag indicators.
 */
data class SubscriptionWithTags(
    val subscription: SubscriptionWithFeed,
    val tags: List<TagEntity>,
)
