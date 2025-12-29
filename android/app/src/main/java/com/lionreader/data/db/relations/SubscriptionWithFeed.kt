package com.lionreader.data.db.relations

import androidx.room.Embedded
import com.lionreader.data.db.entities.FeedEntity
import com.lionreader.data.db.entities.SubscriptionEntity

/**
 * Data class representing a subscription joined with its feed.
 *
 * Combines subscription-specific data (like custom title, unread count)
 * with feed metadata (title, URL, etc.) for display in navigation.
 *
 * Note: The feed fields use a prefix to avoid column name conflicts with subscription.
 */
data class SubscriptionWithFeed(
    @Embedded
    val subscription: SubscriptionEntity,
    @Embedded(prefix = "feed_")
    val feed: FeedEntity,
) {
    /** Returns the custom title if set, otherwise falls back to the feed title */
    val displayTitle: String
        get() = subscription.customTitle ?: feed.title ?: "Untitled"
}
