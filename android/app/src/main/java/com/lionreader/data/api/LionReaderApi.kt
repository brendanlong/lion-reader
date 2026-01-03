package com.lionreader.data.api

import com.lionreader.data.api.models.EntriesCountResponse
import com.lionreader.data.api.models.EntriesResponse
import com.lionreader.data.api.models.EntryResponse
import com.lionreader.data.api.models.EntryType
import com.lionreader.data.api.models.LoginRequest
import com.lionreader.data.api.models.LoginResponse
import com.lionreader.data.api.models.MarkReadRequest
import com.lionreader.data.api.models.NarrationAiAvailableResponse
import com.lionreader.data.api.models.NarrationGenerateRequest
import com.lionreader.data.api.models.NarrationGenerateResponse
import com.lionreader.data.api.models.ProvidersResponse
import com.lionreader.data.api.models.SaveArticleRequest
import com.lionreader.data.api.models.SavedArticleResponse
import com.lionreader.data.api.models.SortOrder
import com.lionreader.data.api.models.StarredCountResponse
import com.lionreader.data.api.models.SubscriptionsResponse
import com.lionreader.data.api.models.TagsResponse
import com.lionreader.data.api.models.UserResponse
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Lion Reader API interface.
 *
 * This interface defines all API endpoints for the Lion Reader backend.
 * It provides a clean abstraction over the HTTP client for use in repositories.
 */
interface LionReaderApi {
    // ============================================================================
    // AUTH ENDPOINTS
    // ============================================================================

    /**
     * Login with email and password.
     *
     * @param email User's email address
     * @param password User's password
     * @return LoginResponse containing user info and session token
     */
    suspend fun login(
        email: String,
        password: String,
    ): ApiResult<LoginResponse>

    /**
     * Get available authentication providers.
     *
     * @return ProvidersResponse containing list of available OAuth providers
     */
    suspend fun getAuthProviders(): ApiResult<ProvidersResponse>

    /**
     * Get the current authenticated user's information.
     *
     * @return UserResponse containing user data
     */
    suspend fun me(): ApiResult<UserResponse>

    /**
     * Log out the current user and invalidate the session.
     */
    suspend fun logout(): ApiResult<Unit>

    // ============================================================================
    // SUBSCRIPTION ENDPOINTS
    // ============================================================================

    /**
     * List all subscriptions for the current user.
     *
     * @return SubscriptionsResponse containing list of subscriptions with feeds
     */
    suspend fun listSubscriptions(): ApiResult<SubscriptionsResponse>

    // ============================================================================
    // TAG ENDPOINTS
    // ============================================================================

    /**
     * List all tags for the current user.
     *
     * @return TagsResponse containing list of tags
     */
    suspend fun listTags(): ApiResult<TagsResponse>

    // ============================================================================
    // ENTRY ENDPOINTS
    // ============================================================================

    /**
     * List entries with optional filters.
     *
     * @param feedId Filter by feed ID
     * @param tagId Filter by tag ID
     * @param uncategorized If true, only return entries from subscriptions with no tags
     * @param unreadOnly Only return unread entries
     * @param starredOnly Only return starred entries
     * @param sortOrder Sort order (newest or oldest)
     * @param cursor Pagination cursor from previous response
     * @param limit Maximum number of entries to return
     * @param type Filter to only include entries of this type
     * @param excludeTypes Filter to exclude entries of these types
     * @return EntriesResponse containing entries and optional next cursor
     */
    suspend fun listEntries(
        feedId: String? = null,
        tagId: String? = null,
        uncategorized: Boolean? = null,
        unreadOnly: Boolean? = null,
        starredOnly: Boolean? = null,
        sortOrder: SortOrder? = null,
        cursor: String? = null,
        limit: Int? = null,
        type: EntryType? = null,
        excludeTypes: List<EntryType>? = null,
    ): ApiResult<EntriesResponse>

    /**
     * Get a single entry by ID.
     *
     * @param id Entry ID
     * @return EntryResponse containing the entry
     */
    suspend fun getEntry(id: String): ApiResult<EntryResponse>

    /**
     * Mark entries as read or unread.
     *
     * @param ids List of entry IDs to update
     * @param read true to mark as read, false to mark as unread
     */
    suspend fun markRead(
        ids: List<String>,
        read: Boolean,
    ): ApiResult<Unit>

    /**
     * Star an entry.
     *
     * @param id Entry ID to star
     */
    suspend fun star(id: String): ApiResult<Unit>

    /**
     * Unstar an entry.
     *
     * @param id Entry ID to unstar
     */
    suspend fun unstar(id: String): ApiResult<Unit>

    /**
     * Get the count of starred entries.
     *
     * @return StarredCountResponse with total and unread counts
     */
    suspend fun getStarredCount(): ApiResult<StarredCountResponse>

    /**
     * Get the count of entries with optional filters.
     *
     * @param feedId Filter by feed ID
     * @param tagId Filter by tag ID
     * @param uncategorized If true, only count entries from subscriptions with no tags
     * @param type Filter to only include entries of this type
     * @param excludeTypes Filter to exclude entries of these types
     * @return EntriesCountResponse with total and unread counts
     */
    suspend fun getEntriesCount(
        feedId: String? = null,
        tagId: String? = null,
        uncategorized: Boolean? = null,
        type: EntryType? = null,
        excludeTypes: List<EntryType>? = null,
    ): ApiResult<EntriesCountResponse>

    // ============================================================================
    // SAVED ARTICLES ENDPOINTS
    // ============================================================================

    /**
     * Save a URL for later reading.
     *
     * @param url URL to save
     * @param html Optional pre-fetched HTML content
     * @param title Optional title hint
     * @return SavedArticleResponse containing the saved article
     */
    suspend fun saveArticle(
        url: String,
        html: String? = null,
        title: String? = null,
    ): ApiResult<SavedArticleResponse>

    /**
     * Delete a saved article.
     *
     * @param id Saved article ID to delete
     */
    suspend fun deleteSavedArticle(id: String): ApiResult<Unit>

    // ============================================================================
    // NARRATION ENDPOINTS
    // ============================================================================

    /**
     * Generate narration-ready text for an entry.
     *
     * Uses LLM preprocessing to convert article content to TTS-ready text.
     * Falls back to plain text conversion if LLM is unavailable.
     *
     * @param id Entry ID to generate narration for
     * @param useLlmNormalization Whether to use LLM for text normalization (default true)
     * @return NarrationGenerateResponse containing narration text and source info
     */
    suspend fun generateNarration(
        id: String,
        useLlmNormalization: Boolean = true,
    ): ApiResult<NarrationGenerateResponse>

    /**
     * Check if AI text processing is available on the server.
     *
     * @return NarrationAiAvailableResponse indicating availability
     */
    suspend fun isAiTextProcessingAvailable(): ApiResult<NarrationAiAvailableResponse>
}

/**
 * Implementation of LionReaderApi using ApiClient.
 */
@Singleton
class LionReaderApiImpl
    @Inject
    constructor(
        private val apiClient: ApiClient,
    ) : LionReaderApi {
        // ============================================================================
        // AUTH ENDPOINTS
        // ============================================================================

        override suspend fun login(
            email: String,
            password: String,
        ): ApiResult<LoginResponse> =
            apiClient.post(
                path = "auth/login",
                body = LoginRequest(email = email, password = password),
            )

        override suspend fun getAuthProviders(): ApiResult<ProvidersResponse> = apiClient.get(path = "auth/providers")

        override suspend fun me(): ApiResult<UserResponse> = apiClient.get(path = "auth/me")

        override suspend fun logout(): ApiResult<Unit> = apiClient.postNoContent(path = "auth/logout")

        // ============================================================================
        // SUBSCRIPTION ENDPOINTS
        // ============================================================================

        override suspend fun listSubscriptions(): ApiResult<SubscriptionsResponse> = apiClient.get(path = "subscriptions")

        // ============================================================================
        // TAG ENDPOINTS
        // ============================================================================

        override suspend fun listTags(): ApiResult<TagsResponse> = apiClient.get(path = "tags")

        // ============================================================================
        // ENTRY ENDPOINTS
        // ============================================================================

        override suspend fun listEntries(
            feedId: String?,
            tagId: String?,
            uncategorized: Boolean?,
            unreadOnly: Boolean?,
            starredOnly: Boolean?,
            sortOrder: SortOrder?,
            cursor: String?,
            limit: Int?,
            type: EntryType?,
            excludeTypes: List<EntryType>?,
        ): ApiResult<EntriesResponse> =
            apiClient.get(path = "entries") {
                queryParam("feedId", feedId)
                queryParam("tagId", tagId)
                queryParam("uncategorized", uncategorized)
                queryParam("unreadOnly", unreadOnly)
                queryParam("starredOnly", starredOnly)
                queryParam("sortOrder", sortOrder?.value)
                queryParam("cursor", cursor)
                queryParam("limit", limit)
                type?.let { queryParam("type", it.name.lowercase()) }
                excludeTypes?.forEach { queryParam("excludeTypes", it.name.lowercase()) }
            }

        override suspend fun getEntry(id: String): ApiResult<EntryResponse> = apiClient.get(path = "entries/$id")

        override suspend fun markRead(
            ids: List<String>,
            read: Boolean,
        ): ApiResult<Unit> =
            apiClient.postNoContent(
                path = "entries/mark-read",
                body = MarkReadRequest(ids = ids, read = read),
            )

        override suspend fun star(id: String): ApiResult<Unit> = apiClient.postNoContent(path = "entries/$id/star")

        override suspend fun unstar(id: String): ApiResult<Unit> = apiClient.deleteNoContent(path = "entries/$id/star")

        override suspend fun getStarredCount(): ApiResult<StarredCountResponse> = apiClient.get(path = "entries/starred/count")

        override suspend fun getEntriesCount(
            feedId: String?,
            tagId: String?,
            uncategorized: Boolean?,
            type: EntryType?,
            excludeTypes: List<EntryType>?,
        ): ApiResult<EntriesCountResponse> =
            apiClient.get(path = "entries/count") {
                queryParam("feedId", feedId)
                queryParam("tagId", tagId)
                queryParam("uncategorized", uncategorized)
                type?.let { queryParam("type", it.name.lowercase()) }
                excludeTypes?.forEach { queryParam("excludeTypes", it.name.lowercase()) }
            }

        // ============================================================================
        // SAVED ARTICLES ENDPOINTS
        // ============================================================================

        override suspend fun saveArticle(
            url: String,
            html: String?,
            title: String?,
        ): ApiResult<SavedArticleResponse> =
            apiClient.post(
                path = "saved",
                body = SaveArticleRequest(url = url, html = html, title = title),
            )

        override suspend fun deleteSavedArticle(id: String): ApiResult<Unit> = apiClient.deleteNoContent(path = "saved/$id")

        // ============================================================================
        // NARRATION ENDPOINTS
        // ============================================================================

        override suspend fun generateNarration(
            id: String,
            useLlmNormalization: Boolean,
        ): ApiResult<NarrationGenerateResponse> =
            apiClient.post(
                path = "narration/generate",
                body = NarrationGenerateRequest(id = id, useLlmNormalization = useLlmNormalization),
            )

        override suspend fun isAiTextProcessingAvailable(): ApiResult<NarrationAiAvailableResponse> =
            apiClient.get(path = "narration/ai-available")
    }
