package com.lionreader.shared.api

import com.lionreader.shared.auth.AppAuth
import io.ktor.client.HttpClient
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.bearerAuth
import io.ktor.client.request.parameter
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.request.url
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlinx.serialization.KSerializer

/** A non-2xx response. `status` 0 means the request never got one (signed out). */
class ApiException(val status: Int, message: String) : Exception(message) {
    /** The server rejected the request itself; retrying it unchanged won't help. */
    val isPermanent: Boolean
        get() = status == 400 || status == 404 || status == 422
}

enum class ListFilter {
    ALL,
    STARRED,
    SAVED,
}

/** The `/api/v1` endpoints the app uses, authenticated with [AppAuth]. */
class LionReaderApi(private val http: HttpClient, private val auth: AppAuth) {
    private val base = "${auth.serverUrl}/api/v1"

    suspend fun listEntries(
        filter: ListFilter,
        cursor: String?,
        subscriptionId: String? = null,
        limit: Int = 100,
    ): EntryListPage =
        get(EntryListPage.serializer(), "/entries") {
            when (filter) {
                ListFilter.ALL -> {}
                ListFilter.STARRED -> parameter("starredOnly", true)
                ListFilter.SAVED -> parameter("type", "saved")
            }
            subscriptionId?.let { parameter("subscriptionId", it) }
            parameter("limit", limit)
            cursor?.let { parameter("cursor", it) }
        }

    suspend fun unreadCount(filter: ListFilter): Int =
        get(UnreadCount.serializer(), "/entries/count") {
                parameter("unreadOnly", true)
                when (filter) {
                    ListFilter.ALL -> {}
                    ListFilter.STARRED -> parameter("starredOnly", true)
                    ListFilter.SAVED -> parameter("type", "saved")
                }
            }
            .unread

    suspend fun getEntries(ids: List<String>): List<FullEntry> =
        post(
                GetManyResponse.serializer(),
                "/entries/batch",
                GetManyRequest(ids),
                GetManyRequest.serializer(),
            )
            .entries

    suspend fun markRead(request: MarkReadRequest): BulkStateResponse =
        post(
            BulkStateResponse.serializer(),
            "/entries/mark-read",
            request,
            MarkReadRequest.serializer(),
        )

    suspend fun setStarred(request: SetStarredRequest): BulkStateResponse =
        post(
            BulkStateResponse.serializer(),
            "/entries/starred",
            request,
            SetStarredRequest.serializer(),
        )

    suspend fun markAllRead(request: MarkAllReadRequest): MarkAllReadResponse =
        post(
            MarkAllReadResponse.serializer(),
            "/entries/mark-all-read",
            request,
            MarkAllReadRequest.serializer(),
        )

    suspend fun listSubscriptions(cursor: String?): SubscriptionPage =
        get(SubscriptionPage.serializer(), "/subscriptions") {
            parameter("limit", 100)
            cursor?.let { parameter("cursor", it) }
        }

    suspend fun listTags(): TagList = get(TagList.serializer(), "/tags") {}

    /** The account this token belongs to. */
    suspend fun me(): AccountUser = get(Me.serializer(), "/auth/me") {}.user

    suspend fun syncChanges(cursors: SyncCursors?): SyncChanges =
        get(SyncChanges.serializer(), "/sync/changes") {
            cursors?.let {
                it.entries?.let { v -> parameter("entries", v) }
                it.entriesAfterId?.let { v -> parameter("entriesAfterId", v) }
                it.subscriptions?.let { v -> parameter("subscriptions", v) }
                it.tags?.let { v -> parameter("tags", v) }
                it.deletions?.let { v -> parameter("deletions", v) }
            }
        }

    private suspend fun <T> get(
        serializer: KSerializer<T>,
        path: String,
        block: HttpRequestBuilder.() -> Unit,
    ): T =
        decode(
            serializer,
            send {
                method = HttpMethod.Get
                url("$base$path")
                block()
            },
        )

    private suspend fun <T, B> post(
        serializer: KSerializer<T>,
        path: String,
        body: B,
        bodySerializer: KSerializer<B>,
    ): T =
        decode(
            serializer,
            send {
                method = HttpMethod.Post
                url("$base$path")
                contentType(ContentType.Application.Json)
                setBody(ApiJson.encodeToString(bodySerializer, body))
            },
        )

    /** Sends with a Bearer token, refreshing and retrying once on a 401. */
    private suspend fun send(block: HttpRequestBuilder.() -> Unit): HttpResponse {
        var token = auth.accessToken() ?: throw ApiException(0, "Signed out")
        var response = http.request {
            block()
            bearerAuth(token)
        }
        if (response.status == HttpStatusCode.Unauthorized) {
            token =
                auth.accessToken(forceRefresh = true, rejected = token)
                    ?: throw ApiException(0, "Signed out")
            response = http.request {
                block()
                bearerAuth(token)
            }
        }
        return response
    }

    private suspend fun <T> decode(serializer: KSerializer<T>, response: HttpResponse): T {
        val text = response.bodyAsText()
        if (!response.status.isSuccess()) {
            throw ApiException(
                response.status.value,
                "HTTP ${response.status.value}: ${text.take(200)}",
            )
        }
        return ApiJson.decodeFromString(serializer, text)
    }
}
