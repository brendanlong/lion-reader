package com.lionreader.shared.sync

import com.lionreader.shared.api.ApiJson
import com.lionreader.shared.api.BulkStateResponse
import com.lionreader.shared.api.Deletion
import com.lionreader.shared.api.EntryListItem
import com.lionreader.shared.api.EntryListPage
import com.lionreader.shared.api.EntryState
import com.lionreader.shared.api.EventEntry
import com.lionreader.shared.api.FeedType
import com.lionreader.shared.api.FullEntry
import com.lionreader.shared.api.GetManyRequest
import com.lionreader.shared.api.GetManyResponse
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.MarkReadRequest
import com.lionreader.shared.api.SetStarredRequest
import com.lionreader.shared.api.StateChange
import com.lionreader.shared.api.Subscription
import com.lionreader.shared.api.SubscriptionPage
import com.lionreader.shared.api.SyncChanges
import com.lionreader.shared.api.SyncCursors
import com.lionreader.shared.api.SyncEvent
import com.lionreader.shared.api.TagList
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
import kotlin.random.Random
import kotlin.time.Instant
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.jsonObject

/**
 * An in-memory model of the server's sync-relevant behavior, faithful where the app depends on it
 * (see src/server/services/entries.ts and src/server/trpc/routers/sync.ts):
 * - read/star writes are last-write-wins on a per-field change time, rebased by the client's clock
 *   offset and capped at now, and respond with the final state of every entry still visible;
 * - `sync.changes` pages entries changed after a cursor in change order (new/updated/state events),
 *   classifying each against the page's own cursor like the real endpoint (#1663), and reports
 *   deletions separately.
 *
 * Counts aren't modeled on the wire: the app counts its own entries.
 *
 * Cursors are opaque to the app, so they're plain change sequence numbers. Faults: a request can
 * fail before it's applied, or (for writes) be applied and then fail — a lost response.
 */
class ModelServer(private val clock: () -> Long, private val random: Random) {
    class Entry(
        val id: String,
        val subscriptionId: String?,
        val type: FeedType,
        val published: Long,
        var read: Boolean,
        var starred: Boolean,
        var readChangedAt: Long?,
        var starredChangedAt: Long,
        var content: String,
        val createdSeq: Long,
        var metadataSeq: Long,
        var stateSeq: Long,
        var deletedSeq: Long? = null,
    ) {
        val updatedSeq: Long
            get() = maxOf(createdSeq, metadataSeq, stateSeq)
    }

    /** A read/star write the server received from the app, after rebasing. */
    data class ClientWrite(
        val entryId: String,
        val field: String,
        val value: Boolean,
        val changedAt: Long,
    )

    val subscriptions = listOf("sub-1", "sub-2")
    val entries = linkedMapOf<String, Entry>()
    val clientWrites = mutableListOf<ClientWrite>()
    var faultRate = 0.0
    var syncPageSize = 5

    /** Every request and its outcome, for debugging a failing seed. */
    val requestLog = mutableListOf<String>()
    private var seq = 0L
    private var nextId = 0

    val visible: List<Entry>
        get() = entries.values.filter { it.deletedSeq == null }

    /**
     * Answered on the test's [dispatcher] rather than MockEngine's IO threads, so overlapping work
     * still interleaves, but in the same order every run and a seed replays exactly.
     */
    fun api(dispatcher: CoroutineDispatcher): LionReaderApi {
        val http =
            HttpClient(MockEngine) {
                engine {
                    this.dispatcher = dispatcher
                    addHandler { request -> handle(request) }
                }
            }
        val tokens =
            object : TokenStore {
                var value: StoredTokens? = StoredTokens("access", "refresh", Long.MAX_VALUE)

                override fun load() = value

                override fun save(tokens: StoredTokens?) {
                    value = tokens
                }
            }
        return LionReaderApi(http, AppAuth("https://lion.test", http, tokens) { clock() })
    }

    // ---- Changes made on the server or another device -------------------

    fun addEntry(
        subscriptionId: String? = subscriptions.random(random),
        read: Boolean = false,
        starred: Boolean = false,
    ): Entry {
        val id = "e%03d".format(nextId++)
        val now = clock()
        val s = ++seq
        return Entry(
                id = id,
                subscriptionId = subscriptionId,
                type = if (subscriptionId == null) FeedType.SAVED else FeedType.WEB,
                published = now,
                read = read,
                starred = starred,
                readChangedAt = null,
                starredChangedAt = now,
                content = "<p>$id v1</p>",
                createdSeq = s,
                metadataSeq = s,
                stateSeq = s,
            )
            .also { entries[id] = it }
    }

    fun editContent(entry: Entry) {
        entry.content = "<p>${entry.id} v${entry.metadataSeq + 1}</p>"
        entry.metadataSeq = ++seq
    }

    fun delete(entry: Entry) {
        entry.deletedSeq = ++seq
    }

    /** Another device's write, stamped now. */
    fun remoteWrite(entry: Entry, field: String, value: Boolean) =
        write(entry, field, value, clock())

    private fun write(entry: Entry, field: String, value: Boolean, changedAt: Long): Boolean {
        val watermark = if (field == "read") entry.readChangedAt else entry.starredChangedAt
        if (watermark != null && watermark > changedAt) return false
        val old = if (field == "read") entry.read else entry.starred
        if (field == "read") {
            entry.read = value
            entry.readChangedAt = changedAt
        } else {
            entry.starred = value
            entry.starredChangedAt = changedAt
        }
        if (old == value) return false
        entry.stateSeq = ++seq
        return true
    }

    /** Unread counts over every visible entry, for the tests' invariant check. */
    data class Counts(
        val all: Int,
        val starred: Int,
        val saved: Int,
        val bySubscription: Map<String, Int>,
    )

    fun counts() =
        Counts(
            all = visible.count { !it.read },
            starred = visible.count { !it.read && it.starred },
            saved = visible.count { !it.read && it.type == FeedType.SAVED },
            bySubscription =
                subscriptions.associateWith { sub ->
                    visible.count { !it.read && it.subscriptionId == sub }
                },
        )

    // ---- HTTP -----------------------------------------------------------

    private fun fault(): Boolean = random.nextDouble() < faultRate

    private fun MockRequestHandleScope.handle(request: HttpRequestData) = run {
        val path = request.url.encodedPath.removePrefix("/api/v1")
        val params = request.url.parameters
        if (fault()) {
            requestLog += "${request.method.value} $path ${params.entries()} -> failed"
            return@run respond("{}", HttpStatusCode.ServiceUnavailable, json)
        }
        val response =
            when (path) {
                "/sync/changes" ->
                    changes(params["entries"]?.toLong(), params["deletions"]?.toLong())
                "/subscriptions" ->
                    encode(
                        SubscriptionPage.serializer(),
                        SubscriptionPage(
                            subscriptions.map { sub ->
                                Subscription(
                                    sub,
                                    FeedType.WEB,
                                    title = sub,
                                )
                            }
                        ),
                    )
                "/tags" -> encode(TagList.serializer(), TagList(emptyList()))
                "/entries" ->
                    list(
                        params["starredOnly"] == "true",
                        params["type"],
                        params["subscriptionId"],
                        params["cursor"],
                        params["limit"],
                    )
                "/entries/batch" -> {
                    val ids = body(request, GetManyRequest.serializer()).ids
                    encode(
                        GetManyResponse.serializer(),
                        GetManyResponse(
                            ids.mapNotNull { id -> visible.find { it.id == id }?.full() }
                        ),
                    )
                }
                "/entries/mark-read" -> {
                    val body = body(request, MarkReadRequest.serializer())
                    stateWrite("read", body.entries, body.read, body.clientSentAt)
                }
                "/entries/starred" -> {
                    val body = body(request, SetStarredRequest.serializer())
                    stateWrite("starred", body.entries, body.starred, body.clientSentAt)
                }
                else -> error("unexpected request $path")
            }
        // A write that was applied but whose answer never arrives.
        val lost = path in WRITES && fault()
        requestLog +=
            "${request.method.value} $path ${params.entries()} -> ${if (lost) "lost " else ""}${response}"
        if (lost) respond("{}", HttpStatusCode.ServiceUnavailable, json)
        else respond(response, HttpStatusCode.OK, json)
    }

    private fun changes(entriesCursor: Long?, deletionsCursor: Long?): String {
        if (entriesCursor == null && deletionsCursor == null) {
            return encode(
                SyncChanges.serializer(),
                SyncChanges(emptyList(), false, SyncCursors(entries = "$seq", deletions = "$seq")),
            )
        }
        val after = entriesCursor ?: 0
        val changed = visible.filter { it.updatedSeq > after }.sortedBy { it.updatedSeq }
        val page = changed.take(syncPageSize)
        val events = page.flatMap { e ->
            buildList {
                if (e.createdSeq > after) {
                    add(
                        SyncEvent.NewEntry(
                            e.id,
                            e.subscriptionId,
                            "feed",
                            e.type,
                            e.eventEntry(),
                        )
                    )
                } else {
                    if (e.metadataSeq > after) {
                        add(
                            SyncEvent.EntryUpdated(
                                e.id,
                                com.lionreader.shared.api.EntryMetadata(title = e.id),
                            )
                        )
                    }
                    if (e.stateSeq > after) {
                        add(
                            SyncEvent.EntryStateChanged(
                                e.id,
                                e.read,
                                e.starred,
                                e.subscriptionId,
                                "feed",
                                e.type,
                                if (e.read) null else e.eventEntry(),
                            )
                        )
                    }
                }
            }
        }
        val deletedAfter = deletionsCursor ?: 0
        val deleted = entries.values.filter { (it.deletedSeq ?: 0) > deletedAfter }
        return encode(
            SyncChanges.serializer(),
            SyncChanges(
                events =
                    events.map {
                        ApiJson.encodeToJsonElement(SyncEvent.serializer(), it).jsonObject
                    },
                hasMore = changed.size > page.size,
                cursors =
                    SyncCursors(
                        entries = "${page.lastOrNull()?.updatedSeq ?: after}",
                        deletions = "${maxOf(deletedAfter, seq)}",
                    ),
                deletions = deleted.map { Deletion(it.id, "${it.deletedSeq}") },
            ),
        )
    }

    private fun list(
        starredOnly: Boolean,
        type: String?,
        subscriptionId: String?,
        cursor: String?,
        limit: String?,
    ): String {
        val matching =
            visible
                .filter { !starredOnly || it.starred }
                .filter { type != "saved" || it.type == FeedType.SAVED }
                .filter { subscriptionId == null || it.subscriptionId == subscriptionId }
                .sortedWith(compareByDescending<Entry> { it.published }.thenByDescending { it.id })
        val offset = cursor?.toInt() ?: 0
        val size = limit?.toInt() ?: 100
        val page = matching.drop(offset).take(size)
        val next = (offset + size).takeIf { it < matching.size }?.toString()
        return encode(EntryListPage.serializer(), EntryListPage(page.map { it.listItem() }, next))
    }

    private fun stateWrite(
        field: String,
        changes: List<StateChange>,
        value: Boolean,
        clientSentAt: String,
    ): String {
        val now = clock()
        val offset = now - Instant.parse(clientSentAt).toEpochMilliseconds()
        for (change in changes) {
            val entry = visible.find { it.id == change.id } ?: continue
            val stamped = change.changedAt?.let { Instant.parse(it).toEpochMilliseconds() } ?: now
            val changedAt = minOf(stamped + offset, now)
            clientWrites += ClientWrite(entry.id, field, value, changedAt)
            write(entry, field, value, changedAt)
        }
        val states =
            changes
                .mapNotNull { c -> visible.find { it.id == c.id } }
                .map { EntryState(it.id, it.subscriptionId, it.read, it.starred) }
        return encode(
            BulkStateResponse.serializer(),
            BulkStateResponse(states),
        )
    }

    private fun Entry.time(millis: Long) = Instant.fromEpochMilliseconds(millis).toString()

    private fun Entry.eventEntry() =
        EventEntry(
            title = id,
            publishedAt = time(published),
            fetchedAt = time(published),
            read = read,
            starred = starred,
        )

    private fun Entry.listItem() =
        EntryListItem(
            id = id,
            subscriptionId = subscriptionId,
            feedId = "feed",
            type = type,
            title = id,
            publishedAt = time(published),
            fetchedAt = time(published),
            read = read,
            starred = starred,
        )

    private fun Entry.full() =
        FullEntry(
            id = id,
            subscriptionId = subscriptionId,
            feedId = "feed",
            type = type,
            title = id,
            publishedAt = time(published),
            fetchedAt = time(published),
            read = read,
            starred = starred,
            contentCleaned = content,
        )

    private fun <T> encode(serializer: KSerializer<T>, value: T) =
        ApiJson.encodeToString(serializer, value)

    private fun <T> body(request: HttpRequestData, serializer: KSerializer<T>): T =
        ApiJson.decodeFromString(serializer, (request.body as TextContent).text)

    private val json = headersOf(HttpHeaders.ContentType, "application/json")

    private companion object {
        val WRITES = setOf("/entries/mark-read", "/entries/starred")
    }
}
