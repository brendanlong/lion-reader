package com.lionreader.data.db.entities

import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * Entity representing an RSS/Atom/JSON feed source.
 *
 * Contains metadata about a feed including its URL, title, and type.
 * Each feed can have multiple subscriptions from different users.
 */
@Entity(tableName = "feeds")
data class FeedEntity(
    @PrimaryKey
    val id: String,
    /** Feed type: "rss", "atom", or "json" */
    val type: String,
    val url: String?,
    val title: String?,
    val description: String?,
    val siteUrl: String?,
    val lastSyncedAt: Long
)
