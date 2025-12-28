package com.lionreader.data.db.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.lionreader.data.db.entities.EntryStateEntity

/**
 * Data Access Object for entry state operations.
 *
 * Manages read/starred states for entries, including tracking
 * states that need to be synced to the server.
 */
@Dao
interface EntryStateDao {

    /**
     * Gets the state for a specific entry.
     *
     * @param entryId The entry ID
     * @return The state or null if no state exists
     */
    @Query("SELECT * FROM entry_states WHERE entryId = :entryId")
    suspend fun getState(entryId: String): EntryStateEntity?

    /**
     * Inserts or replaces an entry state.
     *
     * @param state The state to upsert
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertState(state: EntryStateEntity)

    /**
     * Inserts or replaces multiple entry states.
     *
     * @param states The states to upsert
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertStates(states: List<EntryStateEntity>)

    /**
     * Updates the read status for an entry.
     *
     * Sets the pendingSync flag to indicate this change needs to be synced.
     *
     * @param entryId The entry ID
     * @param read The new read status
     * @param readAt Timestamp when marked read (null if marking unread)
     * @param modifiedAt Timestamp of this modification
     */
    @Query(
        """
        UPDATE entry_states
        SET read = :read, readAt = :readAt, pendingSync = 1, lastModifiedAt = :modifiedAt
        WHERE entryId = :entryId
        """
    )
    suspend fun markRead(entryId: String, read: Boolean, readAt: Long?, modifiedAt: Long)

    /**
     * Updates the starred status for an entry.
     *
     * Sets the pendingSync flag to indicate this change needs to be synced.
     *
     * @param entryId The entry ID
     * @param starred The new starred status
     * @param starredAt Timestamp when starred (null if unstarring)
     * @param modifiedAt Timestamp of this modification
     */
    @Query(
        """
        UPDATE entry_states
        SET starred = :starred, starredAt = :starredAt, pendingSync = 1, lastModifiedAt = :modifiedAt
        WHERE entryId = :entryId
        """
    )
    suspend fun setStarred(entryId: String, starred: Boolean, starredAt: Long?, modifiedAt: Long)

    /**
     * Gets all entry IDs with pending sync.
     *
     * @return List of entry IDs that need to be synced
     */
    @Query("SELECT entryId FROM entry_states WHERE pendingSync = 1")
    suspend fun getPendingSyncEntryIds(): List<String>

    /**
     * Clears the pending sync flag for specified entries.
     *
     * Called after successfully syncing states to the server.
     *
     * @param entryIds The entry IDs to clear
     */
    @Query("UPDATE entry_states SET pendingSync = 0 WHERE entryId IN (:entryIds)")
    suspend fun clearPendingSync(entryIds: List<String>)

    /**
     * Deletes state for a specific entry.
     *
     * @param entryId The entry ID
     */
    @Query("DELETE FROM entry_states WHERE entryId = :entryId")
    suspend fun deleteState(entryId: String)

    /**
     * Gets the count of entries with pending sync.
     *
     * @return Number of entries awaiting sync
     */
    @Query("SELECT COUNT(*) FROM entry_states WHERE pendingSync = 1")
    suspend fun getPendingSyncCount(): Int
}
