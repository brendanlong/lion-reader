package com.lionreader.shared.sync

import com.lionreader.shared.api.ApiJson
import com.lionreader.shared.api.BulkStateResponse
import com.lionreader.shared.api.Deletion
import com.lionreader.shared.api.EntryListItem
import com.lionreader.shared.api.EntryListPage
import com.lionreader.shared.api.EntryState
import com.lionreader.shared.api.FullEntry
import com.lionreader.shared.api.GetManyRequest
import com.lionreader.shared.api.GetManyResponse
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.MarkAllReadRequest
import com.lionreader.shared.api.MarkReadRequest
import com.lionreader.shared.api.SetStarredRequest
import com.lionreader.shared.api.Subscription
import com.lionreader.shared.api.SubscriptionPage
import com.lionreader.shared.api.SyncChanges
import com.lionreader.shared.api.SyncCursors
import com.lionreader.shared.api.SyncEvent
import com.lionreader.shared.api.TagList
import com.lionreader.shared.api.UnreadCount
import com.lionreader.shared.auth.AppAuth
import com.lionreader.shared.auth.StoredTokens
import com.lionreader.shared.auth.TokenStore
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.jsonObject

/**
 * An in-memory stand-in for the server's `/api/v1`, at the HTTP boundary: the code under test
 * builds real requests and parses real JSON.
 */
class FakeServer {
    val entries = linkedMapOf<String, FullEntry>()
    val subscriptions = mutableListOf<Subscription>()

    /** Queued `sync.changes` responses; empty means "no changes". */
    val changes = ArrayDeque<SyncChanges>()
    val requests = mutableListOf<HttpRequestData>()
    val markReadRequests = mutableListOf<MarkReadRequest>()
    val starRequests = mutableListOf<SetStarredRequest>()
    val markAllRequests = mutableListOf<MarkAllReadRequest>()

    /** Status to answer state writes with instead of applying them. */
    var stateWriteFailure: HttpStatusCode? = null

    /** 1-based numbers of `GET /entries` requests to fail (503). */
    val entryPageFailures = mutableSetOf<Int>()
    private var entryPageRequests = 0

    /** Status to answer the next batch fetch with, once. */
    var batchFailure: HttpStatusCode? = null

    /** Runs while a state write is in flight (before the server answers). */
    var duringStateWrite: (suspend () -> Unit)? = null

    val cursors = SyncCursors(entries = "2026-01-01T00:00:00Z", deletions = "2026-01-01T00:00:00Z")

    fun api(): LionReaderApi {
        val http = HttpClient(MockEngine { request -> handle(request) })
        val store =
            object : TokenStore {
                var tokens: StoredTokens? = StoredTokens("access", "refresh", Long.MAX_VALUE)

                override fun load() = tokens

                override fun save(tokens: StoredTokens?) {
                    this.tokens = tokens
                }
            }
        return LionReaderApi(http, AppAuth("https://lion.test", http, store) { 0L })
    }

    fun queueChanges(
        events: List<SyncEvent> = emptyList(),
        times: Int = 1,
        deletions: List<String> = emptyList(),
        resyncRequired: Boolean = false,
    ) =
        repeat(times) {
            changes.addLast(
                SyncChanges(
                    events =
                        events.map {
                            ApiJson.encodeToJsonElement(SyncEvent.serializer(), it).jsonObject
                        },
                    hasMore = false,
                    cursors = cursors.copy(entries = "2026-02-01T00:00:00Z"),
                    deletions = deletions.map { Deletion(it, "2026-02-01T00:00:00Z") },
                    resyncRequired = resyncRequired,
                )
            )
        }

    private suspend fun MockRequestHandleScope.handle(request: HttpRequestData) = run {
        requests += request
        val path = request.url.encodedPath.removePrefix("/api/v1")
        when {
            path == "/sync/changes" ->
                json(
                    SyncChanges.serializer(),
                    changes.removeFirstOrNull() ?: SyncChanges(emptyList(), false, cursors),
                )
            path == "/entries" && entryPageFailures.remove(++entryPageRequests) ->
                respond("{}", HttpStatusCode.ServiceUnavailable, jsonHeaders)
            path == "/entries" -> {
                val params = request.url.parameters
                val matching =
                    entries.values
                        .filter { params["starredOnly"] != "true" || it.starred }
                        .filter {
                            params["type"] == null || it.type.name.lowercase() == params["type"]
                        }
                        .filter {
                            params["subscriptionId"] == null ||
                                it.subscriptionId == params["subscriptionId"]
                        }
                        .sortedByDescending { it.publishedAt ?: it.fetchedAt }
                // Newest first, paged like the server (the cursor is an offset here).
                val offset = params["cursor"]?.toInt() ?: 0
                val limit = params["limit"]?.toInt() ?: 100
                val page = matching.drop(offset).take(limit)
                val next = (offset + limit).takeIf { it < matching.size }?.toString()
                json(EntryListPage.serializer(), EntryListPage(page.map { it.listItem() }, next))
            }
            path == "/entries/count" ->
                json(UnreadCount.serializer(), UnreadCount(entries.values.count { !it.read }))
            path == "/entries/batch" && batchFailure != null -> {
                val status = batchFailure!!
                batchFailure = null
                respond("{}", status, jsonHeaders)
            }
            path == "/entries/batch" -> {
                val ids = body(request, GetManyRequest.serializer()).ids
                json(GetManyResponse.serializer(), GetManyResponse(ids.mapNotNull { entries[it] }))
            }
            path == "/entries/mark-read" -> {
                val body = body(request, MarkReadRequest.serializer())
                markReadRequests += body
                stateWrite(body.entries.map { it.id }) { it.copy(read = body.read) }
            }
            path == "/entries/starred" -> {
                val body = body(request, SetStarredRequest.serializer())
                starRequests += body
                stateWrite(body.entries.map { it.id }) { it.copy(starred = body.starred) }
            }
            path == "/entries/mark-all-read" -> {
                markAllRequests += body(request, MarkAllReadRequest.serializer())
                respond("""{"count":0}""", headers = jsonHeaders)
            }
            path == "/subscriptions" ->
                json(SubscriptionPage.serializer(), SubscriptionPage(subscriptions.toList()))
            path == "/tags" -> json(TagList.serializer(), TagList(emptyList()))
            else -> respond("", HttpStatusCode.NotFound)
        }
    }

    private suspend fun MockRequestHandleScope.stateWrite(
        ids: List<String>,
        change: (FullEntry) -> FullEntry,
    ) =
        stateWriteFailure?.let { respond("{}", it, jsonHeaders) }
            ?: duringStateWrite?.let {
                it()
                null
            }
            ?: run {
                ids.forEach { id -> entries[id]?.let { entries[id] = change(it) } }
                val states =
                    ids.mapNotNull { entries[it] }
                        .map { EntryState(it.id, it.subscriptionId, it.read, it.starred) }
                json(BulkStateResponse.serializer(), BulkStateResponse(states))
            }

    private fun <T> body(request: HttpRequestData, serializer: KSerializer<T>): T =
        ApiJson.decodeFromString(serializer, (request.body as TextContent).text)

    private fun <T> MockRequestHandleScope.json(serializer: KSerializer<T>, value: T) =
        respond(ApiJson.encodeToString(serializer, value), HttpStatusCode.OK, jsonHeaders)

    private val jsonHeaders = headersOf(HttpHeaders.ContentType, "application/json")
}

fun FullEntry.listItem() =
    EntryListItem(
        id = id,
        subscriptionId = subscriptionId,
        feedId = feedId,
        type = type,
        url = url,
        title = title,
        summary = summary,
        publishedAt = publishedAt,
        fetchedAt = fetchedAt,
        read = read,
        starred = starred,
        feedTitle = feedTitle,
    )
