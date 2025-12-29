package com.lionreader.data.db.entities

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index

/**
 * Junction table linking subscriptions to tags.
 *
 * Enables many-to-many relationship between subscriptions and tags.
 * A subscription can have multiple tags, and a tag can be applied to multiple subscriptions.
 */
@Entity(
    tableName = "subscription_tags",
    primaryKeys = ["subscriptionId", "tagId"],
    foreignKeys = [
        ForeignKey(
            entity = SubscriptionEntity::class,
            parentColumns = ["id"],
            childColumns = ["subscriptionId"],
            onDelete = ForeignKey.CASCADE,
        ),
        ForeignKey(
            entity = TagEntity::class,
            parentColumns = ["id"],
            childColumns = ["tagId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [
        Index("subscriptionId"),
        Index("tagId"),
    ],
)
data class SubscriptionTagEntity(
    val subscriptionId: String,
    val tagId: String,
)
