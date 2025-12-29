package com.lionreader.data.repository

import com.lionreader.data.api.ApiResult
import com.lionreader.data.api.LionReaderApi
import com.lionreader.data.api.models.SubscriptionDto
import com.lionreader.data.db.dao.SubscriptionDao
import com.lionreader.data.db.dao.TagDao
import com.lionreader.data.db.entities.FeedEntity
import com.lionreader.data.db.entities.SubscriptionEntity
import com.lionreader.data.db.entities.SubscriptionTagEntity
import com.lionreader.data.db.entities.TagEntity
import com.lionreader.data.db.relations.SubscriptionWithFeed
import kotlinx.coroutines.flow.Flow
import java.time.Instant
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Result of a sync operation.
 */
sealed class SyncResult {
    data object Success : SyncResult()

    data class Error(
        val code: String,
        val message: String,
    ) : SyncResult()

    data object NetworkError : SyncResult()
}

/**
 * Repository for subscription operations.
 *
 * Provides offline-first access to subscriptions. Data is read from the local
 * database via Flow for reactive updates, and synced from the server on demand.
 */
@Singleton
class SubscriptionRepository
    @Inject
    constructor(
        private val api: LionReaderApi,
        private val subscriptionDao: SubscriptionDao,
        private val tagDao: TagDao,
    ) {
        /**
         * Gets all subscriptions with their feeds from local database.
         *
         * Returns a Flow that automatically updates when the underlying data changes.
         * This is the primary way to observe subscriptions in the UI.
         *
         * @return Flow of subscriptions with feed information
         */
        fun getSubscriptions(): Flow<List<SubscriptionWithFeed>> = subscriptionDao.getAllWithFeeds()

        /**
         * Gets a specific subscription by ID.
         *
         * @param subscriptionId The subscription ID
         * @return Flow of the subscription with feed or null
         */
        fun getSubscription(subscriptionId: String): Flow<SubscriptionWithFeed?> = subscriptionDao.getSubscriptionWithFeed(subscriptionId)

        /**
         * Gets the total unread count across all subscriptions.
         *
         * @return Flow of the total unread count
         */
        fun getTotalUnreadCount(): Flow<Int> = subscriptionDao.getTotalUnreadCount()

        /**
         * Gets a subscription by its feed ID.
         *
         * @param feedId The feed ID
         * @return The subscription with feed or null
         */
        suspend fun getSubscriptionByFeedId(feedId: String): SubscriptionWithFeed? = subscriptionDao.getSubscriptionWithFeedByFeedId(feedId)

        /**
         * Syncs subscriptions from the server to the local database.
         *
         * Fetches all subscriptions from the API and updates the local database.
         * This replaces all existing subscription data with fresh data from the server.
         *
         * @return SyncResult indicating success or the type of failure
         */
        suspend fun syncSubscriptions(): SyncResult =
            when (val result = api.listSubscriptions()) {
                is ApiResult.Success -> {
                    val subscriptions = result.data.subscriptions
                    updateLocalDatabase(subscriptions)
                    SyncResult.Success
                }
                is ApiResult.Error -> {
                    SyncResult.Error(result.code, result.message)
                }
                is ApiResult.NetworkError -> {
                    SyncResult.NetworkError
                }
                is ApiResult.Unauthorized -> {
                    SyncResult.Error("UNAUTHORIZED", "Session expired")
                }
                is ApiResult.RateLimited -> {
                    SyncResult.Error("RATE_LIMITED", "Too many requests")
                }
            }

        /**
         * Updates the local database with subscription data from the API.
         */
        private suspend fun updateLocalDatabase(subscriptions: List<SubscriptionDto>) {
            val now = System.currentTimeMillis()

            // Extract feeds and insert them first (due to foreign key constraint)
            val feeds =
                subscriptions.map { dto ->
                    FeedEntity(
                        id = dto.feed.id,
                        type = dto.feed.type,
                        url = dto.feed.url,
                        title = dto.feed.title,
                        description = dto.feed.description,
                        siteUrl = dto.feed.siteUrl,
                        lastSyncedAt = now,
                    )
                }
            subscriptionDao.insertFeeds(feeds)

            // Map subscription DTOs to entities
            val subscriptionEntities =
                subscriptions.map { dto ->
                    SubscriptionEntity(
                        id = dto.id,
                        feedId = dto.feedId,
                        customTitle = dto.customTitle,
                        subscribedAt = parseIsoTimestamp(dto.subscribedAt),
                        unreadCount = dto.unreadCount,
                        lastSyncedAt = now,
                    )
                }
            subscriptionDao.insertAll(subscriptionEntities)

            // Extract tags from subscriptions and update tag associations
            val allTags = mutableMapOf<String, TagEntity>()
            val subscriptionTags = mutableListOf<SubscriptionTagEntity>()

            subscriptions.forEach { subscription ->
                subscription.tags.forEach { tagDto ->
                    // Store unique tags
                    allTags[tagDto.id] =
                        TagEntity(
                            id = tagDto.id,
                            name = tagDto.name,
                            color = tagDto.color,
                            feedCount = 0, // Will be calculated separately if needed
                        )
                    // Store subscription-tag relationship
                    subscriptionTags.add(
                        SubscriptionTagEntity(
                            subscriptionId = subscription.id,
                            tagId = tagDto.id,
                        ),
                    )
                }
            }

            // Insert tags and subscription-tag relationships
            if (allTags.isNotEmpty()) {
                tagDao.insertAll(allTags.values.toList())
            }

            // Clear old subscription-tag relationships and insert new ones
            tagDao.deleteAllSubscriptionTags()
            if (subscriptionTags.isNotEmpty()) {
                tagDao.insertSubscriptionTags(subscriptionTags)
            }
        }

        /**
         * Clears all local subscription data.
         *
         * Called when logging out to remove all cached data.
         */
        suspend fun clearAll() {
            subscriptionDao.deleteAll()
            subscriptionDao.deleteAllFeeds()
        }

        /**
         * Parses an ISO 8601 timestamp string to milliseconds.
         */
        private fun parseIsoTimestamp(timestamp: String): Long =
            try {
                Instant.parse(timestamp).toEpochMilli()
            } catch (e: Exception) {
                System.currentTimeMillis()
            }
    }
