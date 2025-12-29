package com.lionreader.data.repository

import com.lionreader.data.api.ApiResult
import com.lionreader.data.api.LionReaderApi
import com.lionreader.data.api.models.TagDto
import com.lionreader.data.db.dao.TagDao
import com.lionreader.data.db.entities.TagEntity
import kotlinx.coroutines.flow.Flow
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Repository for tag operations.
 *
 * Provides offline-first access to tags. Data is read from the local
 * database via Flow for reactive updates, and synced from the server on demand.
 */
@Singleton
class TagRepository
    @Inject
    constructor(
        private val api: LionReaderApi,
        private val tagDao: TagDao,
    ) {
        /**
         * Gets all tags from local database.
         *
         * Returns a Flow that automatically updates when the underlying data changes.
         * This is the primary way to observe tags in the UI.
         *
         * @return Flow of all tags sorted by name
         */
        fun getTags(): Flow<List<TagEntity>> = tagDao.getAll()

        /**
         * Gets a specific tag by ID.
         *
         * @param tagId The tag ID
         * @return The tag or null if not found
         */
        suspend fun getTag(tagId: String): TagEntity? = tagDao.getTag(tagId)

        /**
         * Gets all tags for a specific subscription.
         *
         * @param subscriptionId The subscription ID
         * @return List of tags associated with this subscription
         */
        suspend fun getTagsForSubscription(subscriptionId: String): List<TagEntity> = tagDao.getTagEntitiesForSubscription(subscriptionId)

        /**
         * Syncs tags from the server to the local database.
         *
         * Fetches all tags from the API and updates the local database.
         * This updates existing tags and adds new ones.
         *
         * @return SyncResult indicating success or the type of failure
         */
        suspend fun syncTags(): SyncResult =
            when (val result = api.listTags()) {
                is ApiResult.Success -> {
                    val tags = result.data.tags
                    updateLocalDatabase(tags)
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
         * Updates the local database with tag data from the API.
         */
        private suspend fun updateLocalDatabase(tags: List<TagDto>) {
            val tagEntities =
                tags.map { dto ->
                    TagEntity(
                        id = dto.id,
                        name = dto.name,
                        color = dto.color,
                        feedCount = dto.feedCount,
                    )
                }
            tagDao.insertAll(tagEntities)
        }

        /**
         * Clears all local tag data.
         *
         * Called when logging out to remove all cached data.
         */
        suspend fun clearAll() {
            tagDao.deleteAllSubscriptionTags()
            tagDao.deleteAll()
        }
    }
