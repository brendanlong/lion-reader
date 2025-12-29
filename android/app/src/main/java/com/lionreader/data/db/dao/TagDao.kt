package com.lionreader.data.db.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.lionreader.data.db.entities.SubscriptionTagEntity
import com.lionreader.data.db.entities.TagEntity
import kotlinx.coroutines.flow.Flow

/**
 * Data Access Object for tag operations.
 *
 * Manages tags and subscription-tag relationships.
 * Tag queries are reactive using Flow for navigation drawer updates.
 */
@Dao
interface TagDao {
    /**
     * Gets all tags sorted by name.
     *
     * @return Flow of all tags
     */
    @Query("SELECT * FROM tags ORDER BY name ASC")
    fun getAll(): Flow<List<TagEntity>>

    /**
     * Gets a specific tag by ID.
     *
     * @param tagId The tag ID
     * @return The tag or null
     */
    @Query("SELECT * FROM tags WHERE id = :tagId")
    suspend fun getTag(tagId: String): TagEntity?

    /**
     * Gets all subscription-tag relationships for a specific subscription.
     *
     * @param subscriptionId The subscription ID
     * @return List of subscription-tag relationships
     */
    @Query("SELECT * FROM subscription_tags WHERE subscriptionId = :subscriptionId")
    suspend fun getTagsForSubscription(subscriptionId: String): List<SubscriptionTagEntity>

    /**
     * Gets all tags associated with a subscription.
     *
     * @param subscriptionId The subscription ID
     * @return List of tags for this subscription
     */
    @Query(
        """
        SELECT t.* FROM tags t
        JOIN subscription_tags st ON t.id = st.tagId
        WHERE st.subscriptionId = :subscriptionId
        ORDER BY t.name ASC
        """,
    )
    suspend fun getTagEntitiesForSubscription(subscriptionId: String): List<TagEntity>

    /**
     * Gets all subscription IDs that have a specific tag.
     *
     * @param tagId The tag ID
     * @return List of subscription IDs with this tag
     */
    @Query("SELECT subscriptionId FROM subscription_tags WHERE tagId = :tagId")
    suspend fun getSubscriptionIdsForTag(tagId: String): List<String>

    /**
     * Inserts or replaces tags.
     *
     * @param tags The tags to insert
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(tags: List<TagEntity>)

    /**
     * Inserts or replaces subscription-tag relationships.
     *
     * @param subscriptionTags The relationships to insert
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertSubscriptionTags(subscriptionTags: List<SubscriptionTagEntity>)

    /**
     * Deletes all tags.
     *
     * Used when logging out or syncing a fresh list.
     */
    @Query("DELETE FROM tags")
    suspend fun deleteAll()

    /**
     * Deletes all subscription-tag relationships.
     *
     * Used when logging out or syncing a fresh list.
     */
    @Query("DELETE FROM subscription_tags")
    suspend fun deleteAllSubscriptionTags()

    /**
     * Deletes subscription-tag relationships for a specific subscription.
     *
     * @param subscriptionId The subscription ID
     */
    @Query("DELETE FROM subscription_tags WHERE subscriptionId = :subscriptionId")
    suspend fun deleteTagsForSubscription(subscriptionId: String)
}
