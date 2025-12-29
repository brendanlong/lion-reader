package com.lionreader.data.db.entities

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

/**
 * Entity tracking the read/starred state of an entry.
 *
 * Separated from EntryEntity to allow independent updates to state
 * without modifying the entry content. Supports offline sync tracking.
 */
@Entity(
    tableName = "entry_states",
    foreignKeys = [
        ForeignKey(
            entity = EntryEntity::class,
            parentColumns = ["id"],
            childColumns = ["entryId"],
            onDelete = ForeignKey.CASCADE,
        ),
    ],
    indices = [
        Index("entryId"),
        Index("pendingSync"),
    ],
)
data class EntryStateEntity(
    @PrimaryKey
    val entryId: String,
    val read: Boolean,
    val starred: Boolean,
    val readAt: Long?,
    val starredAt: Long?,
    /** Flag indicating this state change needs to be synced to server */
    val pendingSync: Boolean = false,
    val lastModifiedAt: Long,
)
