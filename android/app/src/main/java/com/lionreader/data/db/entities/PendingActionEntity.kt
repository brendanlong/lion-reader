package com.lionreader.data.db.entities

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Entity for tracking pending offline actions.
 *
 * When the device is offline, user actions (mark read, star, etc.) are
 * queued here and synced when connectivity is restored.
 */
@Entity(
    tableName = "pending_actions",
    foreignKeys = [
        ForeignKey(
            entity = EntryEntity::class,
            parentColumns = ["id"],
            childColumns = ["entryId"],
            onDelete = ForeignKey.CASCADE
        )
    ],
    indices = [
        Index("entryId"),
        Index("createdAt")
    ]
)
data class PendingActionEntity(
    @PrimaryKey(autoGenerate = true)
    val id: Long = 0,
    /** Action type: "mark_read", "mark_unread", "star", "unstar" */
    val type: String,
    val entryId: String,
    val createdAt: Long,
    /** Number of failed sync attempts */
    val retryCount: Int = 0
) {
    companion object {
        const val TYPE_MARK_READ = "mark_read"
        const val TYPE_MARK_UNREAD = "mark_unread"
        const val TYPE_STAR = "star"
        const val TYPE_UNSTAR = "unstar"

        /** Maximum retry attempts before action is discarded */
        const val MAX_RETRY_COUNT = 5
    }
}
