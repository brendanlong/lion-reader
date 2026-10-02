package com.lionreader.shared.sync

import com.lionreader.shared.api.ApiJson
import com.lionreader.shared.api.BulkStateResponse
import com.lionreader.shared.api.Deletion
import com.lionreader.shared.api.EntryListItem
import com.lionreader.shared.api.EntryListPage
import com.lionreader.shared.api.EntryState
import com.lionreader.shared.api.FullEntry
import com.lionreader.shared.api.GenerateSummaryRequest
import com.lionreader.shared.api.GeneratedSummary
import com.lionreader.shared.api.GetManyRequest
import com.lionreader.shared.api.GetManyResponse
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.MarkReadRequest
import com.lionreader.shared.api.SaveArticleRequest
import com.lionreader.shared.api.SaveArticleResponse
import com.lionreader.shared.api.SavedArticle
import com.lionreader.shared.api.SetStarredRequest
import com.lionreader.shared.api.Subscription
import com.lionreader.shared.api.SubscriptionPage
import com.lionreader.shared.api.SummarizationAvailability
import com.lionreader.shared.api.SyncChanges
import com.lionreader.shared.api.SyncCursors
import com.lionreader.shared.api.SyncEvent
import com.lionreader.shared.api.TagList
import com.lionreader.shared.auth.AppAuth
import com.lionreader.shared.auth.StoredTokens
import com.lionreader.shared.auth.TokenStore
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.MockEngineConfig
import io.ktor.client.engine.mock.MockRequestHandleScope
import io.ktor.client.engine.mock.respond
import io.ktor.client.request.HttpRequestData
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.awaitCancellation
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.jsonObject

/**
 * An in-memory stand-in for the server's `/api/v1`, at the HTTP boundary: the code under test
 * builds real requests and parses real JSON, and gets the real endpoints' 400 for more items than
 * they accept ([ServerLimits]).
 */
class FakeServer {
    val entries = linkedMapOf<String, FullEntry>()
    val subscriptions = mutableListOf<Subscription>()

    /** Summaries the server would generate, by entry id; others fail (500). */
    val summaries = mutableMapOf<String, String>()

    /** Runs while a summary request is in flight (before the server answers). */
    var duringSummary: (suspend () -> Unit)? = null

    /**
     * Links saved with `POST /saved`; [saveError] answers them instead, with its status and body.
     */
    val savedUrls = mutableListOf<String>()
    var saveError: Pair<HttpStatusCode, String>? = null

    /** Queued `sync.changes` responses; empty means "no changes". */
    val changes = ArrayDeque<SyncChanges>()

    /** Status and body to answer `/events` with, instead of [eventStreams]. */
    var eventsError: Pair<HttpStatusCode, String>? = null
    val requests = mutableListOf<HttpRequestData>()
    val markReadRequests = mutableListOf<MarkReadRequest>()
    val starRequests = mutableListOf<SetStarredRequest>()

    /** Status to answer state writes with instead of applying them. */
    var stateWriteFailure: HttpStatusCode? = null

    /** 1-based numbers of `GET /entries` requests to fail (503). */
    val entryPageFailures = mutableSetOf<Int>()
    private var entryPageRequests = 0

    /** Status to answer the next batch fetch with, once. */
    var batchFailure: HttpStatusCode? = null

    /** Runs while a body fetch for these ids is in flight (before the server answers). */
    var duringBatch: (suspend (List<String>) -> Unit)? = null

    /**
     * What each connection to `/events` gets, in order: a stream (which ends when its channel
     * does), or null for a 503. Once they run out, connections stay open with nothing to say.
     */
    val eventStreams = ArrayDeque<ByteReadChannel?>()

    /** Runs while a state write is in flight (before the server answers). */
    var duringStateWrite: (suspend () -> Unit)? = null

    val cursors = SyncCursors(entries = "2026-01-01T00:00:00Z", deletions = "2026-01-01T00:00:00Z")

    /** [dispatcher]: where it answers; a test's own, to answer in its virtual time. */
    fun api(dispatcher: CoroutineDispatcher? = null): LionReaderApi {
        val http =
            HttpClient(
                MockEngine(
                    MockEngineConfig().apply {
                        addHandler { request -> handle(request) }
                        dispatcher?.let { this.dispatcher = it }
                    }
                )
            )
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
        hasMore: Boolean = false,
        /** The page's next entries cursor. */
        entriesCursor: String = "2026-02-01T00:00:00Z",
    ) {
        val entryIds = events.mapNotNull {
            when (it) {
                is SyncEvent.NewEntry -> it.entryId
                is SyncEvent.EntryUpdated -> it.entryId
                is SyncEvent.EntryStateChanged -> it.entryId
                else -> null
            }
        }
        require(entryIds.distinct().size <= ServerLimits.SYNC_PAGE_ENTRIES) {
            "a sync.changes page holds at most ${ServerLimits.SYNC_PAGE_ENTRIES} entries"
        }
        repeat(times) {
            changes.addLast(
                SyncChanges(
                    events =
                        events.map {
                            ApiJson.encodeToJsonElement(SyncEvent.serializer(), it).jsonObject
                        },
                    hasMore = hasMore,
                    cursors = cursors.copy(entries = entriesCursor),
                    deletions = deletions.map { Deletion(it, "2026-02-01T00:00:00Z") },
                    resyncRequired = resyncRequired,
                )
            )
        }
    }

    private suspend fun MockRequestHandleScope.handle(request: HttpRequestData) = run {
        requests += request
        val path = request.url.encodedPath.removePrefix("/api/v1")
        when {
            path == "/events" && eventsError != null ->
                respond(eventsError!!.second, eventsError!!.first, jsonHeaders)
            path == "/events" ->
                if (eventStreams.isEmpty()) awaitCancellation()
                else
                    eventStreams.removeFirst()?.let {
                        respond(
                            it,
                            HttpStatusCode.OK,
                            headersOf("Content-Type", "text/event-stream"),
                        )
                    } ?: respond("{}", HttpStatusCode.ServiceUnavailable, jsonHeaders)
            path == "/sync/changes" ->
                json(
                    SyncChanges.serializer(),
                    changes.removeFirstOrNull()
                        ?: SyncChanges(emptyList(), false, cursors, emptyList(), false),
                )
            path == "/entries" &&
                (request.url.parameters["limit"]?.toInt() ?: 0) > ServerLimits.LIST_LIMIT ->
                respond("{}", HttpStatusCode.BadRequest, jsonHeaders)
            path == "/entries" && entryPageFailures.remove(++entryPageRequests) ->
                respond("{}", HttpStatusCode.ServiceUnavailable, jsonHeaders)
            path == "/entries" -> {
                val params = request.url.parameters
                val recentlyRead = params["sortBy"] == "readChanged"
                val matching =
                    entries.values
                        .filter { !recentlyRead || it.readChangedAt != null }
                        .filter { params["starredOnly"] != "true" || it.starred }
                        .filter {
                            params["type"] == null || it.type.name.lowercase() == params["type"]
                        }
                        .filter {
                            params["subscriptionId"] == null ||
                                it.subscriptionId == params["subscriptionId"]
                        }
                        .sortedByDescending {
                            if (recentlyRead) it.readChangedAt else it.publishedAt ?: it.fetchedAt
                        }
                // Newest first, paged like the server (the cursor is an offset here).
                val offset = params["cursor"]?.toInt() ?: 0
                val limit = params["limit"]?.toInt() ?: 100
                val page = matching.drop(offset).take(limit)
                val next = (offset + limit).takeIf { it < matching.size }?.toString()
                json(EntryListPage.serializer(), EntryListPage(page.map { it.listItem() }, next))
            }
            path == "/entries/batch" && batchFailure != null -> {
                val status = batchFailure!!
                batchFailure = null
                respond("{}", status, jsonHeaders)
            }
            path == "/entries/batch" -> {
                val ids = body(request, GetManyRequest.serializer()).ids
                if (ids.size !in 1..ServerLimits.BATCH_IDS) {
                    respond("{}", HttpStatusCode.BadRequest, jsonHeaders)
                } else {
                    duringBatch?.invoke(ids)
                    json(
                        GetManyResponse.serializer(),
                        GetManyResponse(ids.mapNotNull { entries[it] }),
                    )
                }
            }
            path == "/summarization/available" ->
                json(
                    SummarizationAvailability.serializer(),
                    SummarizationAvailability(summaries.isNotEmpty()),
                )
            path == "/summarization/generate" -> {
                val entryId = body(request, GenerateSummaryRequest.serializer()).entryId
                duringSummary?.invoke()
                val summary = summaries[entryId]
                if (summary == null) respond("{}", HttpStatusCode.InternalServerError, jsonHeaders)
                else json(GeneratedSummary.serializer(), GeneratedSummary(summary))
            }
            path == "/saved" -> {
                val url = body(request, SaveArticleRequest.serializer()).url
                val error = saveError
                if (error != null) respond(error.second, error.first, jsonHeaders)
                else {
                    savedUrls += url
                    json(
                        SaveArticleResponse.serializer(),
                        SaveArticleResponse(SavedArticle("s-1", "Saved")),
                    )
                }
            }
            path == "/entries/mark-read" -> {
                val body = body(request, MarkReadRequest.serializer())
                markReadRequests += body
                val times = body.entries.associate { it.id to it.changedAt }
                stateWrite(body.entries.map { it.id }) {
                    it.copy(read = body.read, readChangedAt = times[it.id])
                }
            }
            path == "/entries/starred" -> {
                val body = body(request, SetStarredRequest.serializer())
                starRequests += body
                stateWrite(body.entries.map { it.id }) { it.copy(starred = body.starred) }
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
        (if (ids.size !in 1..ServerLimits.STATE_WRITE_ENTRIES) HttpStatusCode.BadRequest else null)
            ?.let { respond("{}", it, jsonHeaders) }
            ?: stateWriteFailure?.let { respond("{}", it, jsonHeaders) }
            ?: duringStateWrite?.let {
                it()
                null
            }
            ?: run {
                ids.forEach { id -> entries[id]?.let { entries[id] = change(it) } }
                val states =
                    ids.mapNotNull { entries[it] }
                        .map {
                            EntryState(
                                it.id,
                                it.subscriptionId,
                                it.read,
                                it.starred,
                                it.readChangedAt,
                            )
                        }
                json(BulkStateResponse.serializer(), BulkStateResponse(states))
            }

    private fun <T> body(request: HttpRequestData, serializer: KSerializer<T>): T =
        ApiJson.decodeFromString(serializer, (request.body as TextContent).text)

    private fun <T> MockRequestHandleScope.json(serializer: KSerializer<T>, value: T) =
        respond(ApiJson.encodeToString(serializer, value), HttpStatusCode.OK, jsonHeaders)

    private val jsonHeaders = headersOf(HttpHeaders.ContentType, "application/json")
}

/** What the real endpoints accept per request (src/server/trpc/routers/entries.ts, sync.ts). */
object ServerLimits {
    /** `/entries/batch` ids. */
    const val BATCH_IDS = 100
    /** `/entries` `limit`. */
    const val LIST_LIMIT = 100
    /** `/entries/mark-read` and `/entries/starred` entries. */
    const val STATE_WRITE_ENTRIES = 1000
    /** Entries in one `sync.changes` page. */
    const val SYNC_PAGE_ENTRIES = 500
}

fun FullEntry.listItem() =
    EntryListItem(
        id = id,
        subscriptionId = subscriptionId,
        feedId = feedId,
        type = type,
        url = url,
        title = title,
        author = author,
        summary = summary,
        publishedAt = publishedAt,
        fetchedAt = fetchedAt,
        read = read,
        starred = starred,
        feedTitle = feedTitle,
        siteName = siteName,
        readChangedAt = readChangedAt,
    )
