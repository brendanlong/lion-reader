package com.lionreader.data.repository

import com.lionreader.data.api.ApiResult
import com.lionreader.data.api.LionReaderApi
import com.lionreader.data.api.models.SavedArticleFullDto
import com.lionreader.data.api.models.SavedArticleListItemDto
import com.lionreader.data.api.models.SavedCountResponse
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Result of listing saved articles.
 */
sealed class SavedArticlesResult {
    data class Success(
        val articles: List<SavedArticleListItemDto>,
        val nextCursor: String? = null,
    ) : SavedArticlesResult()

    data class Error(
        val code: String,
        val message: String,
    ) : SavedArticlesResult()

    data object NetworkError : SavedArticlesResult()

    data object Unauthorized : SavedArticlesResult()
}

/**
 * Result of fetching a single saved article.
 */
sealed class SavedArticleFetchResult {
    data class Success(
        val article: SavedArticleFullDto,
    ) : SavedArticleFetchResult()

    data object NotFound : SavedArticleFetchResult()

    data class Error(
        val code: String,
        val message: String,
    ) : SavedArticleFetchResult()

    data object NetworkError : SavedArticleFetchResult()

    data object Unauthorized : SavedArticleFetchResult()
}

/**
 * Result of saving a new article.
 */
sealed class SaveArticleResult {
    data class Success(
        val article: SavedArticleFullDto,
    ) : SaveArticleResult()

    data class Error(
        val code: String,
        val message: String,
    ) : SaveArticleResult()

    data object NetworkError : SaveArticleResult()

    data object Unauthorized : SaveArticleResult()
}

/**
 * Filter options for querying saved articles.
 */
data class SavedArticleFilters(
    val unreadOnly: Boolean = false,
    val starredOnly: Boolean = false,
    val limit: Int = 50,
)

/**
 * Repository for saved article operations.
 *
 * Provides access to the saved articles (read-it-later) feature.
 * Articles are saved to the server and fetched on demand.
 */
@Singleton
class SavedArticleRepository
    @Inject
    constructor(
        private val api: LionReaderApi,
    ) {
        /**
         * Lists saved articles with optional filters.
         *
         * @param filters Filter options
         * @param cursor Pagination cursor from previous response
         * @return SavedArticlesResult with articles or error
         */
        suspend fun listSavedArticles(
            filters: SavedArticleFilters = SavedArticleFilters(),
            cursor: String? = null,
        ): SavedArticlesResult =
            when (
                val result =
                    api.listSavedArticles(
                        unreadOnly = if (filters.unreadOnly) true else null,
                        starredOnly = if (filters.starredOnly) true else null,
                        cursor = cursor,
                        limit = filters.limit,
                    )
            ) {
                is ApiResult.Success -> {
                    SavedArticlesResult.Success(
                        articles = result.data.items,
                        nextCursor = result.data.nextCursor,
                    )
                }
                is ApiResult.Error -> {
                    SavedArticlesResult.Error(result.code, result.message)
                }
                is ApiResult.NetworkError -> {
                    SavedArticlesResult.NetworkError
                }
                is ApiResult.Unauthorized -> {
                    SavedArticlesResult.Unauthorized
                }
                is ApiResult.RateLimited -> {
                    SavedArticlesResult.Error("RATE_LIMITED", "Too many requests")
                }
            }

        /**
         * Gets a single saved article by ID.
         *
         * @param id Saved article ID
         * @return SavedArticleFetchResult with article or error
         */
        suspend fun getSavedArticle(id: String): SavedArticleFetchResult =
            when (val result = api.getSavedArticle(id)) {
                is ApiResult.Success -> {
                    SavedArticleFetchResult.Success(result.data.article)
                }
                is ApiResult.Error -> {
                    if (result.code == "NOT_FOUND") {
                        SavedArticleFetchResult.NotFound
                    } else {
                        SavedArticleFetchResult.Error(result.code, result.message)
                    }
                }
                is ApiResult.NetworkError -> {
                    SavedArticleFetchResult.NetworkError
                }
                is ApiResult.Unauthorized -> {
                    SavedArticleFetchResult.Unauthorized
                }
                is ApiResult.RateLimited -> {
                    SavedArticleFetchResult.Error("RATE_LIMITED", "Too many requests")
                }
            }

        /**
         * Saves a URL for later reading.
         *
         * @param url URL to save
         * @param html Optional pre-fetched HTML content
         * @param title Optional title hint
         * @return SaveArticleResult with saved article or error
         */
        suspend fun saveArticle(
            url: String,
            html: String? = null,
            title: String? = null,
        ): SaveArticleResult =
            when (val result = api.saveArticle(url = url, html = html, title = title)) {
                is ApiResult.Success -> {
                    SaveArticleResult.Success(result.data.article)
                }
                is ApiResult.Error -> {
                    SaveArticleResult.Error(result.code, result.message)
                }
                is ApiResult.NetworkError -> {
                    SaveArticleResult.NetworkError
                }
                is ApiResult.Unauthorized -> {
                    SaveArticleResult.Unauthorized
                }
                is ApiResult.RateLimited -> {
                    SaveArticleResult.Error("RATE_LIMITED", "Too many requests")
                }
            }

        /**
         * Deletes a saved article.
         *
         * @param id Saved article ID to delete
         * @return true if successful, false otherwise
         */
        suspend fun deleteSavedArticle(id: String): Boolean =
            when (api.deleteSavedArticle(id)) {
                is ApiResult.Success -> true
                else -> false
            }

        /**
         * Marks saved articles as read or unread.
         *
         * Uses the unified entries endpoint since saved articles share the same
         * underlying entry data.
         *
         * @param ids List of saved article IDs
         * @param read true to mark as read, false to mark as unread
         * @return true if successful, false otherwise
         */
        suspend fun markRead(
            ids: List<String>,
            read: Boolean,
        ): Boolean =
            when (api.markRead(ids, read)) {
                is ApiResult.Success -> true
                else -> false
            }

        /**
         * Stars a saved article.
         *
         * Uses the unified entries endpoint since saved articles share the same
         * underlying entry data.
         *
         * @param id Saved article ID
         * @return true if successful, false otherwise
         */
        suspend fun star(id: String): Boolean =
            when (api.star(id)) {
                is ApiResult.Success -> true
                else -> false
            }

        /**
         * Unstars a saved article.
         *
         * Uses the unified entries endpoint since saved articles share the same
         * underlying entry data.
         *
         * @param id Saved article ID
         * @return true if successful, false otherwise
         */
        suspend fun unstar(id: String): Boolean =
            when (api.unstar(id)) {
                is ApiResult.Success -> true
                else -> false
            }

        /**
         * Toggles the starred status of a saved article.
         *
         * @param id Saved article ID
         * @param currentlyStarred Current starred status
         * @return true if successful, false otherwise
         */
        suspend fun toggleStarred(
            id: String,
            currentlyStarred: Boolean,
        ): Boolean =
            if (currentlyStarred) {
                unstar(id)
            } else {
                star(id)
            }

        /**
         * Gets the count of saved articles.
         *
         * @return SavedCountResponse with total and unread counts, or null on failure
         */
        suspend fun getCount(): SavedCountResponse? =
            when (val result = api.getSavedCount()) {
                is ApiResult.Success -> result.data
                else -> null
            }
    }
