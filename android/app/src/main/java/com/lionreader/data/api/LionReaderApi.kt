package com.lionreader.data.api

import com.lionreader.data.api.models.EntriesResponse
import com.lionreader.data.api.models.EntryResponse
import com.lionreader.data.api.models.LoginRequest
import com.lionreader.data.api.models.LoginResponse
import com.lionreader.data.api.models.MarkReadRequest
import com.lionreader.data.api.models.ProvidersResponse
import com.lionreader.data.api.models.SortOrder
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
     * @param unreadOnly Only return unread entries
     * @param starredOnly Only return starred entries
     * @param sortOrder Sort order (newest or oldest)
     * @param cursor Pagination cursor from previous response
     * @param limit Maximum number of entries to return
     * @return EntriesResponse containing entries and optional next cursor
     */
    suspend fun listEntries(
        feedId: String? = null,
        tagId: String? = null,
        unreadOnly: Boolean? = null,
        starredOnly: Boolean? = null,
        sortOrder: SortOrder? = null,
        cursor: String? = null,
        limit: Int? = null,
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
                path = "/auth/login",
                body = LoginRequest(email = email, password = password),
            )

        override suspend fun getAuthProviders(): ApiResult<ProvidersResponse> = apiClient.get(path = "/auth/providers")

        override suspend fun me(): ApiResult<UserResponse> = apiClient.get(path = "/auth/me")

        override suspend fun logout(): ApiResult<Unit> = apiClient.postNoContent(path = "/auth/logout")

        // ============================================================================
        // SUBSCRIPTION ENDPOINTS
        // ============================================================================

        override suspend fun listSubscriptions(): ApiResult<SubscriptionsResponse> = apiClient.get(path = "/subscriptions")

        // ============================================================================
        // TAG ENDPOINTS
        // ============================================================================

        override suspend fun listTags(): ApiResult<TagsResponse> = apiClient.get(path = "/tags")

        // ============================================================================
        // ENTRY ENDPOINTS
        // ============================================================================

        override suspend fun listEntries(
            feedId: String?,
            tagId: String?,
            unreadOnly: Boolean?,
            starredOnly: Boolean?,
            sortOrder: SortOrder?,
            cursor: String?,
            limit: Int?,
        ): ApiResult<EntriesResponse> =
            apiClient.get(path = "/entries") {
                queryParam("feedId", feedId)
                queryParam("tagId", tagId)
                queryParam("unreadOnly", unreadOnly)
                queryParam("starredOnly", starredOnly)
                queryParam("sortOrder", sortOrder?.value)
                queryParam("cursor", cursor)
                queryParam("limit", limit)
            }

        override suspend fun getEntry(id: String): ApiResult<EntryResponse> = apiClient.get(path = "/entries/$id")

        override suspend fun markRead(
            ids: List<String>,
            read: Boolean,
        ): ApiResult<Unit> =
            apiClient.postNoContent(
                path = "/entries/mark-read",
                body = MarkReadRequest(ids = ids, read = read),
            )

        override suspend fun star(id: String): ApiResult<Unit> = apiClient.postNoContent(path = "/entries/$id/star")

        override suspend fun unstar(id: String): ApiResult<Unit> = apiClient.deleteNoContent(path = "/entries/$id/star")
    }
