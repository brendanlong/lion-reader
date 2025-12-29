package com.lionreader.data.db.dao

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Insert
import androidx.room.Query
import com.lionreader.data.db.entities.PendingActionEntity

/**
 * Data Access Object for pending action operations.
 *
 * Manages the queue of offline actions that need to be synced
 * when connectivity is restored.
 */
@Dao
interface PendingActionDao {
    /**
     * Inserts a new pending action.
     *
     * @param action The action to queue
     * @return The generated ID for the action
     */
    @Insert
    suspend fun insert(action: PendingActionEntity): Long

    /**
     * Gets all pending actions ordered by creation time.
     *
     * Actions are processed in order to maintain consistency.
     *
     * @return List of pending actions
     */
    @Query("SELECT * FROM pending_actions ORDER BY createdAt ASC")
    suspend fun getAllPending(): List<PendingActionEntity>

    /**
     * Gets pending actions of a specific type.
     *
     * @param type The action type to filter by
     * @return List of pending actions of that type
     */
    @Query("SELECT * FROM pending_actions WHERE type = :type ORDER BY createdAt ASC")
    suspend fun getPendingByType(type: String): List<PendingActionEntity>

    /**
     * Deletes a pending action.
     *
     * Called after an action has been successfully synced.
     *
     * @param action The action to delete
     */
    @Delete
    suspend fun delete(action: PendingActionEntity)

    /**
     * Deletes multiple pending actions.
     *
     * @param actions The actions to delete
     */
    @Delete
    suspend fun deleteAll(actions: List<PendingActionEntity>)

    /**
     * Increments the retry count for an action.
     *
     * Called when a sync attempt fails.
     *
     * @param id The action ID
     */
    @Query("UPDATE pending_actions SET retryCount = retryCount + 1 WHERE id = :id")
    suspend fun incrementRetry(id: Long)

    /**
     * Deletes actions that have exceeded the maximum retry count.
     *
     * Called to clean up actions that repeatedly fail.
     */
    @Query("DELETE FROM pending_actions WHERE retryCount > 5")
    suspend fun deleteFailedActions()

    /**
     * Gets the count of pending actions.
     *
     * @return Number of pending actions
     */
    @Query("SELECT COUNT(*) FROM pending_actions")
    suspend fun getPendingCount(): Int

    /**
     * Gets the count of failed actions (exceeding retry limit).
     *
     * @return Number of actions with retryCount > 5
     */
    @Query("SELECT COUNT(*) FROM pending_actions WHERE retryCount > 5")
    suspend fun getFailedCount(): Int

    /**
     * Deletes all pending actions for a specific entry.
     *
     * @param entryId The entry ID
     */
    @Query("DELETE FROM pending_actions WHERE entryId = :entryId")
    suspend fun deleteForEntry(entryId: String)
}
