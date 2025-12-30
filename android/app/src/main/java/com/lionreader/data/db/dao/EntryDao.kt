package com.lionreader.data.db.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.lionreader.data.db.entities.EntryEntity
import com.lionreader.data.db.relations.EntryWithState
import kotlinx.coroutines.flow.Flow

/**
 * Data Access Object for entry operations.
 *
 * Provides methods for querying, inserting, and deleting feed entries.
 * Entry queries are reactive using Flow for automatic UI updates.
 */
@Dao
interface EntryDao {
    /**
     * Gets entries with their read/starred state, filtered by various criteria.
     *
     * @param feedId Optional filter by feed ID
     * @param tagId Optional filter by tag ID (entries from feeds with this tag)
     * @param unreadOnly If true, only return unread entries
     * @param starredOnly If true, only return starred entries
     * @param sortOrder Sort direction: "newest" or "oldest"
     * @param limit Maximum number of entries to return
     * @param offset Number of entries to skip (for pagination)
     * @return Flow of entries matching the criteria
     */
    @Query(
        """
        SELECT e.*, s.read, s.starred, s.readAt, s.starredAt
        FROM entries e
        LEFT JOIN entry_states s ON e.id = s.entryId
        WHERE (:feedId IS NULL OR e.feedId = :feedId)
          AND (:tagId IS NULL OR e.feedId IN (
              SELECT sub.feedId FROM subscriptions sub
              JOIN subscription_tags st ON sub.id = st.subscriptionId
              WHERE st.tagId = :tagId
          ))
          AND (:unreadOnly = 0 OR COALESCE(s.read, 0) = 0)
          AND (:starredOnly = 0 OR COALESCE(s.starred, 0) = 1)
        ORDER BY
            CASE WHEN :sortOrder = 'newest' THEN COALESCE(e.publishedAt, e.fetchedAt) END DESC,
            CASE WHEN :sortOrder = 'newest' THEN e.id END DESC,
            CASE WHEN :sortOrder = 'oldest' THEN COALESCE(e.publishedAt, e.fetchedAt) END ASC,
            CASE WHEN :sortOrder = 'oldest' THEN e.id END ASC
        LIMIT :limit OFFSET :offset
        """,
    )
    fun getEntries(
        feedId: String?,
        tagId: String?,
        unreadOnly: Boolean,
        starredOnly: Boolean,
        sortOrder: String,
        limit: Int,
        offset: Int,
    ): Flow<List<EntryWithState>>

    /**
     * Gets a single entry by ID.
     *
     * @param id The entry ID
     * @return The entry or null if not found
     */
    @Query("SELECT * FROM entries WHERE id = :id")
    suspend fun getEntry(id: String): EntryEntity?

    /**
     * Gets a single entry with its state by ID.
     *
     * @param id The entry ID
     * @return Flow of the entry with state or null
     */
    @Query(
        """
        SELECT e.*, s.read, s.starred, s.readAt, s.starredAt
        FROM entries e
        LEFT JOIN entry_states s ON e.id = s.entryId
        WHERE e.id = :id
        """,
    )
    fun getEntryWithState(id: String): Flow<EntryWithState?>

    /**
     * Inserts or replaces a list of entries.
     *
     * @param entries The entries to insert
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertEntries(entries: List<EntryEntity>)

    /**
     * Deletes all entries for a specific feed.
     *
     * @param feedId The feed ID whose entries should be deleted
     */
    @Query("DELETE FROM entries WHERE feedId = :feedId")
    suspend fun deleteEntriesForFeed(feedId: String)

    /**
     * Deletes entries older than a specified timestamp.
     *
     * Used for cleanup of old entries to manage database size.
     *
     * @param olderThan Entries with fetchedAt before this timestamp will be deleted
     */
    @Query("DELETE FROM entries WHERE fetchedAt < :olderThan")
    suspend fun deleteOldEntries(olderThan: Long)

    /**
     * Gets the count of entries for a specific feed.
     *
     * @param feedId The feed ID
     * @return Number of entries for this feed
     */
    @Query("SELECT COUNT(*) FROM entries WHERE feedId = :feedId")
    suspend fun getEntryCountForFeed(feedId: String): Int

    /**
     * Gets entry IDs ordered by the same criteria as getEntries.
     *
     * Used for swipe navigation to determine previous/next entries.
     * Returns only IDs for efficiency since we just need navigation context.
     *
     * @param feedId Optional filter by feed ID
     * @param tagId Optional filter by tag ID (entries from feeds with this tag)
     * @param unreadOnly If true, only return unread entries
     * @param starredOnly If true, only return starred entries
     * @param sortOrder Sort direction: "newest" or "oldest"
     * @return List of entry IDs in display order
     */
    @Query(
        """
        SELECT e.id
        FROM entries e
        LEFT JOIN entry_states s ON e.id = s.entryId
        WHERE (:feedId IS NULL OR e.feedId = :feedId)
          AND (:tagId IS NULL OR e.feedId IN (
              SELECT sub.feedId FROM subscriptions sub
              JOIN subscription_tags st ON sub.id = st.subscriptionId
              WHERE st.tagId = :tagId
          ))
          AND (:unreadOnly = 0 OR COALESCE(s.read, 0) = 0)
          AND (:starredOnly = 0 OR COALESCE(s.starred, 0) = 1)
        ORDER BY
            CASE WHEN :sortOrder = 'newest' THEN COALESCE(e.publishedAt, e.fetchedAt) END DESC,
            CASE WHEN :sortOrder = 'newest' THEN e.id END DESC,
            CASE WHEN :sortOrder = 'oldest' THEN COALESCE(e.publishedAt, e.fetchedAt) END ASC,
            CASE WHEN :sortOrder = 'oldest' THEN e.id END ASC
        """,
    )
    suspend fun getEntryIds(
        feedId: String?,
        tagId: String?,
        unreadOnly: Boolean,
        starredOnly: Boolean,
        sortOrder: String,
    ): List<String>
}
