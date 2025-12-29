package com.lionreader.data.db.entities

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Entity representing a feed entry (article).
 *
 * Contains all content and metadata for a single entry from a feed.
 * Both original and cleaned content versions are stored for offline reading.
 *
 * Note: feedId is not a foreign key because entries can exist for feeds
 * the user is no longer subscribed to (e.g., starred entries from old
 * subscriptions). Feed metadata is denormalized in feedTitle.
 */
@Entity(
    tableName = "entries",
    indices = [
        Index("feedId"),
        Index("fetchedAt"),
        Index("publishedAt"),
    ],
)
data class EntryEntity(
    @PrimaryKey
    val id: String,
    val feedId: String,
    val url: String?,
    val title: String?,
    val author: String?,
    val summary: String?,
    val contentOriginal: String?,
    val contentCleaned: String?,
    val publishedAt: Long?,
    val fetchedAt: Long,
    val feedTitle: String?,
    val lastSyncedAt: Long,
)
