package com.lionreader.data.db.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.lionreader.data.db.entities.FeedEntity
import com.lionreader.data.db.entities.SubscriptionEntity
import com.lionreader.data.db.relations.SubscriptionWithFeed
import kotlinx.coroutines.flow.Flow

/**
 * Data Access Object for subscription operations.
 *
 * Manages subscriptions and their associated feeds.
 * Subscription queries are reactive using Flow for navigation drawer updates.
 */
@Dao
interface SubscriptionDao {
    /**
     * Gets all subscriptions with their feeds, sorted by display title.
     *
     * The display title is the custom title if set, otherwise the feed title.
     *
     * @return Flow of subscriptions with feeds
     */
    @Query(
        """
        SELECT s.*,
               f.id AS feed_id,
               f.type AS feed_type,
               f.url AS feed_url,
               f.title AS feed_title,
               f.description AS feed_description,
               f.siteUrl AS feed_siteUrl,
               f.lastSyncedAt AS feed_lastSyncedAt
        FROM subscriptions s
        JOIN feeds f ON s.feedId = f.id
        ORDER BY COALESCE(s.customTitle, f.title) ASC
        """,
    )
    fun getAllWithFeeds(): Flow<List<SubscriptionWithFeed>>

    /**
     * Gets a specific subscription with its feed.
     *
     * @param subscriptionId The subscription ID
     * @return Flow of the subscription with feed or null
     */
    @Query(
        """
        SELECT s.*,
               f.id AS feed_id,
               f.type AS feed_type,
               f.url AS feed_url,
               f.title AS feed_title,
               f.description AS feed_description,
               f.siteUrl AS feed_siteUrl,
               f.lastSyncedAt AS feed_lastSyncedAt
        FROM subscriptions s
        JOIN feeds f ON s.feedId = f.id
        WHERE s.id = :subscriptionId
        """,
    )
    fun getSubscriptionWithFeed(subscriptionId: String): Flow<SubscriptionWithFeed?>

    /**
     * Gets subscription by feed ID.
     *
     * @param feedId The feed ID
     * @return The subscription or null
     */
    @Query("SELECT * FROM subscriptions WHERE feedId = :feedId")
    suspend fun getByFeedId(feedId: String): SubscriptionEntity?

    /**
     * Gets a subscription with its feed by feed ID.
     *
     * @param feedId The feed ID
     * @return The subscription with feed or null
     */
    @Query(
        """
        SELECT s.*,
               f.id AS feed_id,
               f.type AS feed_type,
               f.url AS feed_url,
               f.title AS feed_title,
               f.description AS feed_description,
               f.siteUrl AS feed_siteUrl,
               f.lastSyncedAt AS feed_lastSyncedAt
        FROM subscriptions s
        JOIN feeds f ON s.feedId = f.id
        WHERE s.feedId = :feedId
        """,
    )
    suspend fun getSubscriptionWithFeedByFeedId(feedId: String): SubscriptionWithFeed?

    /**
     * Inserts or replaces subscriptions.
     *
     * @param subscriptions The subscriptions to insert
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertAll(subscriptions: List<SubscriptionEntity>)

    /**
     * Inserts or replaces feeds.
     *
     * @param feeds The feeds to insert
     */
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertFeeds(feeds: List<FeedEntity>)

    /**
     * Updates the unread count for a subscription.
     *
     * @param subscriptionId The subscription ID
     * @param unreadCount The new unread count
     */
    @Query("UPDATE subscriptions SET unreadCount = :unreadCount WHERE id = :subscriptionId")
    suspend fun updateUnreadCount(
        subscriptionId: String,
        unreadCount: Int,
    )

    /**
     * Deletes all subscriptions.
     *
     * Used when logging out or syncing a fresh list.
     */
    @Query("DELETE FROM subscriptions")
    suspend fun deleteAll()

    /**
     * Deletes all feeds.
     *
     * Used when logging out or syncing a fresh list.
     */
    @Query("DELETE FROM feeds")
    suspend fun deleteAllFeeds()

    /**
     * Gets the total unread count across all subscriptions.
     *
     * @return Sum of unread counts
     */
    @Query("SELECT COALESCE(SUM(unreadCount), 0) FROM subscriptions")
    fun getTotalUnreadCount(): Flow<Int>

    /**
     * Gets the unread count for subscriptions with no tags (uncategorized).
     *
     * @return Sum of unread counts for uncategorized subscriptions
     */
    @Query(
        """
        SELECT COALESCE(SUM(s.unreadCount), 0) FROM subscriptions s
        WHERE s.id NOT IN (
            SELECT st.subscriptionId FROM subscription_tags st
        )
        """,
    )
    fun getUncategorizedUnreadCount(): Flow<Int>

    /**
     * Gets subscriptions that have no tags (uncategorized).
     *
     * @return Flow of uncategorized subscriptions with feeds
     */
    @Query(
        """
        SELECT s.*,
               f.id AS feed_id,
               f.type AS feed_type,
               f.url AS feed_url,
               f.title AS feed_title,
               f.description AS feed_description,
               f.siteUrl AS feed_siteUrl,
               f.lastSyncedAt AS feed_lastSyncedAt
        FROM subscriptions s
        JOIN feeds f ON s.feedId = f.id
        WHERE s.id NOT IN (
            SELECT st.subscriptionId FROM subscription_tags st
        )
        ORDER BY COALESCE(s.customTitle, f.title) ASC
        """,
    )
    fun getUncategorizedWithFeeds(): Flow<List<SubscriptionWithFeed>>

    /**
     * Deletes subscriptions by a list of IDs.
     *
     * Used during incremental sync to remove unsubscribed feeds.
     *
     * @param ids The subscription IDs to delete
     */
    @Query("DELETE FROM subscriptions WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<String>)
}
