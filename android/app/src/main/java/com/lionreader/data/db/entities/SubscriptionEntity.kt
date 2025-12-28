package com.lionreader.data.db.entities

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Entity representing a user's subscription to a feed.
 *
 * Links a user to a feed with optional customizations like a custom title.
 * Tracks unread count and last sync time for the subscription.
 */
@Entity(
    tableName = "subscriptions",
    foreignKeys = [
        ForeignKey(
            entity = FeedEntity::class,
            parentColumns = ["id"],
            childColumns = ["feedId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [Index("feedId")]
)
data class SubscriptionEntity(
    @PrimaryKey
    val id: String,
    val feedId: String,
    val customTitle: String?,
    val subscribedAt: Long,
    val unreadCount: Int,
    val lastSyncedAt: Long
)
