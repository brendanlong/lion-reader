package com.lionreader.shared.sync

import com.lionreader.shared.account.ServerConnection
import com.lionreader.shared.api.ApiJson
import com.lionreader.shared.api.BulkStateResponse
import com.lionreader.shared.api.Deletion
import com.lionreader.shared.api.EntryListItem
import com.lionreader.shared.api.EntryListPage
import com.lionreader.shared.api.EntryState
import com.lionreader.shared.api.EventEntry
import com.lionreader.shared.api.FullEntry
import com.lionreader.shared.api.GenerateSummaryRequest
import com.lionreader.shared.api.GeneratedSummary
import com.lionreader.shared.api.GetManyRequest
import com.lionreader.shared.api.GetManyResponse
import com.lionreader.shared.api.ImportEbookRequest
import com.lionreader.shared.api.ImportedCollection
import com.lionreader.shared.api.ImportedEbook
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.MarkReadRequest
import com.lionreader.shared.api.SAVED_TYPE
import com.lionreader.shared.api.SaveArticleRequest
import com.lionreader.shared.api.SaveArticleResponse
import com.lionreader.shared.api.SavedArticle
import com.lionreader.shared.api.ServerLimits
import com.lionreader.shared.api.SetStarredRequest
import com.lionreader.shared.api.Subscription
import com.lionreader.shared.api.SubscriptionPage
import com.lionreader.shared.api.SummarizationAvailability
import com.lionreader.shared.api.SyncChanges
import com.lionreader.shared.api.SyncCursors
import com.lionreader.shared.api.SyncEvent
import com.lionreader.shared.api.TagList
import com.lionreader.shared.api.UploadFileRequest
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
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.jsonObject

/**
 * An in-memory stand-in for the server's `/api/v1`, at the HTTP boundary: the code under test
 * builds real requests and parses real JSON, and gets the real endpoints' 400 for more items than
 * they accept ([ServerLimits]).
 *
 * Entries it serves carry `subscriptionIds` as the server's do: their own plus the [collections]
 * holding them (a saved article's is the Saved subscription, [savedSubscriptionId]).
 */
class FakeServer {
    val entries = linkedMapOf<String, FullEntry>()
    val subscriptions = mutableListOf<Subscription>()

    /** Each collection's article ids, by its subscription id. */
    val collections = mutableMapOf<String, MutableSet<String>>()

    /**
     * The user's Saved subscription, which `/subscriptions` lists after [subscriptions] (as the
     * server does, #1846 phase 9); null before a save.
     */
    var savedSubscriptionId: String? = SAVED_SUBSCRIPTION

    /** Summaries the server would generate, by entry id; others fail (500). */
    val summaries = mutableMapOf<String, String>()

    /** Runs while a summary request is in flight (before the server answers). */
    var duringSummary: (suspend () -> Unit)? = null

    /**
     * Links saved with `POST /saved`; [saveError] answers them instead, with its status and body.
     */
    val savedUrls = mutableListOf<String>()
    var saveError: Pair<HttpStatusCode, String>? = null

    /** Files saved with `POST /saved/upload`, as sent (Base64 content). */
    val uploads = mutableListOf<UploadFileRequest>()

    /** Ebooks imported with `POST /collections/import-ebook`, as sent (Base64 content). */
    val ebookImports = mutableListOf<ImportEbookRequest>()

    /** Queued `sync.changes` responses; empty means "no changes". */
    val changes = ArrayDeque<SyncChanges>()

    /** Status and body to answer `/narration/speech` with. */
    var speechError: Pair<HttpStatusCode, String>? = null
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

    /** Runs while a state write is in flight (before the server answers). */
    var duringStateWrite: (suspend () -> Unit)? = null

    val cursors = SyncCursors(entries = "2026-01-01T00:00:00Z", deletions = "2026-01-01T00:00:00Z")

    /** [dispatcher]: where it answers; a test's own, to answer in its virtual time. */
    fun api(dispatcher: CoroutineDispatcher? = null): LionReaderApi {
        val http = http(dispatcher)
        return LionReaderApi(http, AppAuth("https://lion.test", http, signedIn()) { 0L })
    }

    /** A signed-in connection to this server. */
    fun connection(): ServerConnection =
        ServerConnection("https://lion.test", http(null), signedIn(), "/callback") { 0L }

    private fun http(dispatcher: CoroutineDispatcher?) =
        HttpClient(
            MockEngine(
                MockEngineConfig().apply {
                    addHandler { request -> handle(request) }
                    dispatcher?.let { this.dispatcher = it }
                }
            )
        )

    private fun signedIn() =
        object : TokenStore {
            var tokens: StoredTokens? = StoredTokens("access", "refresh", Long.MAX_VALUE)

            override fun load() = tokens

            override fun save(tokens: StoredTokens?) {
                this.tokens = tokens
            }
        }

    /**
     * The `subscriptionIds` the server sends for an entry: as served, or for one it doesn't have,
     * [origin] and the [collections] holding it.
     */
    fun membershipsOf(entryId: String, origin: String? = null): List<String> =
        entries[entryId]?.let(::memberships)
            ?: (listOfNotNull(origin) + collectionsOf(entryId)).sorted()

    /** A `new_entry` event, with the memberships the server would send ([membershipsOf]). */
    fun newEntry(entryId: String, subscriptionId: String?, entry: EventEntry?) =
        SyncEvent.NewEntry(entryId, subscriptionId, membershipsOf(entryId, subscriptionId), entry)

    /** An `entry_state_changed` event, with the memberships the server would send. */
    fun stateChanged(
        entryId: String,
        read: Boolean,
        starred: Boolean,
        subscriptionId: String? = null,
        entry: EventEntry? = null,
    ) =
        SyncEvent.EntryStateChanged(
            entryId,
            read,
            starred,
            subscriptionIds = membershipsOf(entryId, subscriptionId),
            subscriptionId = subscriptionId,
            entry = entry,
        )

    /**
     * Queues a page. Its entry events' `subscriptionIds` lose subscriptions the page deletes, as
     * the server reports memberships as of the page.
     */
    fun queueChanges(
        events: List<SyncEvent> = emptyList(),
        times: Int = 1,
        deletions: List<String> = emptyList(),
        resyncRequired: Boolean = false,
        hasMore: Boolean = false,
        /** The page's next entries cursor. */
        entriesCursor: String = "2026-02-01T00:00:00Z",
    ) {
        val deleted =
            events.filterIsInstance<SyncEvent.SubscriptionDeleted>().map {
                it.subscriptionId
            }
        val sent = events.map {
            when (it) {
                is SyncEvent.NewEntry -> it.copy(subscriptionIds = it.subscriptionIds - deleted)
                is SyncEvent.EntryStateChanged ->
                    it.copy(subscriptionIds = it.subscriptionIds - deleted)
                else -> it
            }
        }
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
                        sent.map {
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
            path == "/narration/speech" && speechError != null ->
                respond(speechError!!.second, speechError!!.first, jsonHeaders)
            path == "/sync/changes" ->
                json(
                    SyncChanges.serializer(),
                    changes.removeFirstOrNull()
                        ?: SyncChanges(emptyList(), false, cursors, emptyList(), false),
                )
            path == "/entries" &&
                (request.url.parameters["limit"]?.toInt() ?: 0) > ServerLimits.ENTRIES_PAGE_SIZE ->
                respond("{}", HttpStatusCode.BadRequest, jsonHeaders)
            path == "/entries" && entryPageFailures.remove(++entryPageRequests) ->
                respond("{}", HttpStatusCode.ServiceUnavailable, jsonHeaders)
            path == "/entries" -> {
                val params = request.url.parameters
                val recentlyRead = params["sortBy"] == "readChanged"
                // Saved is the Saved subscription's list.
                val type = params["type"]
                val savedList = type == "saved"
                val subscriptionIds =
                    listOfNotNull(
                        params["subscriptionId"],
                        if (savedList) savedSubscriptionId ?: "none" else null,
                    )
                val matching =
                    entries.values
                        .filter { !recentlyRead || it.readChangedAt != null }
                        .filter { params["starredOnly"] != "true" || it.starred }
                        .filter { type == null || savedList || it.type == type }
                        .filter { entry -> subscriptionIds.all { it in memberships(entry) } }
                        .map(::served)
                        .sortedByDescending {
                            if (recentlyRead) it.readChangedAt else it.publishedAt ?: it.fetchedAt
                        }
                        // Highest first, then the unscored (only this order is asked for).
                        .let { newest ->
                            if (params["sortBy"] != "score") newest
                            else
                                newest.sortedWith(
                                    compareBy<FullEntry, Double?>(nullsLast()) {
                                        it.score?.unaryMinus()
                                    }
                                )
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
                if (ids.size !in 1..ServerLimits.ENTRIES_PAGE_SIZE) {
                    respond("{}", HttpStatusCode.BadRequest, jsonHeaders)
                } else {
                    duringBatch?.invoke(ids)
                    json(
                        GetManyResponse.serializer(),
                        GetManyResponse(ids.mapNotNull { entries[it]?.let(::served) }),
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
            path == "/collections/import-ebook" -> {
                ebookImports += body(request, ImportEbookRequest.serializer())
                json(
                    ImportedEbook.serializer(),
                    ImportedEbook(ImportedCollection("c-1", "A Tale"), listOf("e-1", "e-2")),
                )
            }
            path == "/saved/upload" -> {
                uploads += body(request, UploadFileRequest.serializer())
                json(
                    SaveArticleResponse.serializer(),
                    SaveArticleResponse(SavedArticle("s-2", "Uploaded")),
                )
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
                json(
                    SubscriptionPage.serializer(),
                    SubscriptionPage(
                        subscriptions +
                            listOfNotNull(
                                savedSubscriptionId?.let {
                                    Subscription(
                                        it,
                                        type = SAVED_TYPE,
                                        title = "Saved",
                                        tags = emptyList(),
                                    )
                                }
                            )
                    ),
                )
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
                                it.read,
                                it.starred,
                                it.readChangedAt,
                            )
                        }
                json(BulkStateResponse.serializer(), BulkStateResponse(states))
            }

    private fun collectionsOf(entryId: String): List<String> =
        collections.filterValues { entryId in it }.keys.sorted()

    private fun memberships(entry: FullEntry): List<String> =
        (entry.subscriptionIds + collectionsOf(entry.id)).distinct().sorted()

    /** The entry as the server sends it. */
    private fun served(entry: FullEntry): FullEntry =
        entry.copy(subscriptionIds = memberships(entry))

    private fun <T> body(request: HttpRequestData, serializer: KSerializer<T>): T =
        ApiJson.decodeFromString(serializer, (request.body as TextContent).text)

    private fun <T> MockRequestHandleScope.json(serializer: KSerializer<T>, value: T) =
        respond(ApiJson.encodeToString(serializer, value), HttpStatusCode.OK, jsonHeaders)

    private val jsonHeaders = headersOf(HttpHeaders.ContentType, "application/json")
}

/** The Saved subscription's id in [FakeServer]'s answers. */
const val SAVED_SUBSCRIPTION = "saved-sub"

fun FullEntry.listItem() =
    EntryListItem(
        id = id,
        subscriptionId = subscriptionId,
        subscriptionIds = subscriptionIds,
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
        score = score,
        positions = positions,
    )
