package com.lionreader.data.db.relations

import androidx.room.Embedded
import com.lionreader.data.db.entities.EntryEntity

/**
 * Data class representing an entry with its read/starred state.
 *
 * Used by queries that join entries with their states for display in lists.
 * State fields are nullable since an entry may not have a state record yet.
 */
data class EntryWithState(
    @Embedded
    val entry: EntryEntity,
    val read: Boolean?,
    val starred: Boolean?,
    val readAt: Long?,
    val starredAt: Long?
) {
    /** Returns true if the entry has been read, defaults to false if no state exists */
    val isRead: Boolean get() = read ?: false

    /** Returns true if the entry is starred, defaults to false if no state exists */
    val isStarred: Boolean get() = starred ?: false
}
