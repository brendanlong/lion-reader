package com.lionreader.shared.sync

import com.lionreader.shared.api.ApiJson
import com.lionreader.shared.api.BulkStateResponse
import com.lionreader.shared.api.COLLECTION_TYPE
import com.lionreader.shared.api.Deletion
import com.lionreader.shared.api.EntryListItem
import com.lionreader.shared.api.EntryListPage
import com.lionreader.shared.api.EntryState
import com.lionreader.shared.api.EventEntry
import com.lionreader.shared.api.FullEntry
import com.lionreader.shared.api.GetManyRequest
import com.lionreader.shared.api.GetManyResponse
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.MarkReadRequest
import com.lionreader.shared.api.SAVED_TYPE
import com.lionreader.shared.api.ServerLimits
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
 * (see src/server/services/entry-state.ts and src/server/services/sync.ts):
 * - read/star writes are last-write-wins on a per-field change time, rebased by the client's clock
 *   offset and capped at now, and respond with the final state of every entry still visible;
 * - `sync.changes` pages entries changed after a cursor in change order (new/updated/state events),
 *   classifying each against `entriesSince` (the catch-up's start) or, without it, the page's own
 *   cursor (#1663), and reports deletions separately;
 * - every subscription holds its entries as memberships (#1846): entries and their events carry
 *   `subscriptionIds` (a feed or Saved, plus [collection] if the entry's in it), and joining or
 *   leaving the collection is a state change. Saved is a subscription the list doesn't show, whose
 *   id `/subscriptions` reports once the first save has created it;
 * - an entry's score and its position in [collection] (#2064) travel with its state: setting either
 *   is a state change, and lists (sorted by score on request) and entries carry both;
 * - requests over the real endpoints' size limits ([ServerLimits]) get a 400.
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
        val type: String,
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
        val collections: MutableSet<String> = mutableSetOf(),
        var score: Double? = null,
        /** By collection, for those of [collections] that give it one. */
        val positions: MutableMap<String, Double> = mutableMapOf(),
    ) {
        val updatedSeq: Long
            get() = maxOf(createdSeq, metadataSeq, stateSeq)

        val saved: Boolean
            get() = subscriptionId == null

        /** The subscription the server reports as the entry's origin. */
        val origin: String?
            get() = if (saved) SAVED_SUBSCRIPTION_ID else subscriptionId

        /** Every subscription holding the entry. */
        val memberships: List<String>
            get() = (listOfNotNull(origin) + collections).sorted()
    }

    /** A read/star write the server received from the app, after rebasing. */
    data class ClientWrite(
        val entryId: String,
        val field: String,
        val value: Boolean,
        val changedAt: Long,
    )

    val subscriptions = listOf("sub-1", "sub-2")
    val collection = "col-1"

    /** Created by the first save. */
    private var savedSubscriptionId: String? = null
    val entries = linkedMapOf<String, Entry>()
    val clientWrites = mutableListOf<ClientWrite>()
    var faultRate = 0.0
    var syncPageSize = 5
        set(value) {
            require(value <= ServerLimits.SYNC_PAGE_ENTRIES)
            field = value
        }

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
        if (subscriptionId == null) savedSubscriptionId = SAVED_SUBSCRIPTION_ID
        val s = ++seq
        return Entry(
                id = id,
                subscriptionId = subscriptionId,
                type = if (subscriptionId == null) "saved" else "web",
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

    /** Adds the entry to [collection], or takes it out (and its position with it). */
    fun toggleCollection(entry: Entry) {
        if (entry.collections.remove(collection)) entry.positions.remove(collection)
        else entry.collections += collection
        entry.stateSeq = ++seq
    }

    /** Sets or clears the entry's score, as an assistant over MCP does. */
    fun setScore(entry: Entry, score: Double?) {
        if (entry.score == score) return
        entry.score = score
        entry.stateSeq = ++seq
    }

    /** Sets or clears the entry's position in [collection], if it's in it. */
    fun setPosition(entry: Entry, position: Double?) {
        if (collection !in entry.collections || entry.positions[collection] == position) return
        if (position == null) entry.positions.remove(collection)
        else entry.positions[collection] = position
        entry.stateSeq = ++seq
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
            saved = visible.count { !it.read && it.saved },
            bySubscription =
                (subscriptions + collection).associateWith { sub ->
                    visible.count { !it.read && sub in it.memberships }
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
                    changes(
                        params["entries"]?.toLong(),
                        params["entriesSince"]?.toLong(),
                        params["deletions"]?.toLong(),
                    )
                "/subscriptions" ->
                    encode(
                        SubscriptionPage.serializer(),
                        SubscriptionPage(
                            subscriptions.map { sub ->
                                Subscription(
                                    sub,
                                    type = "web",
                                    title = sub,
                                    originalTitle = sub,
                                    tags = emptyList(),
                                )
                            } +
                                Subscription(
                                    collection,
                                    type = COLLECTION_TYPE,
                                    title = collection,
                                    tags = emptyList(),
                                ) +
                                // Listed like any subscription once the first save creates it.
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
                "/tags" -> encode(TagList.serializer(), TagList(emptyList()))
                "/entries" -> {
                    val limit = params["limit"]?.toInt() ?: 100
                    if (limit !in 1..ServerLimits.ENTRIES_PAGE_SIZE) return@run badRequest(request)
                    if (params["sortBy"] == "score" && params["sortOrder"] != "highest") {
                        return@run badRequest(request)
                    }
                    list(
                        params["sortBy"],
                        params["starredOnly"] == "true",
                        params["type"],
                        params["subscriptionId"],
                        params["cursor"],
                        limit,
                    )
                }
                "/entries/batch" -> {
                    val ids = body(request, GetManyRequest.serializer()).ids
                    if (ids.size !in 1..ServerLimits.ENTRIES_PAGE_SIZE)
                        return@run badRequest(request)
                    encode(
                        GetManyResponse.serializer(),
                        GetManyResponse(
                            ids.mapNotNull { id -> visible.find { it.id == id }?.full() }
                        ),
                    )
                }
                "/entries/mark-read" -> {
                    val body = body(request, MarkReadRequest.serializer())
                    if (body.entries.size !in 1..ServerLimits.STATE_WRITE_ENTRIES) {
                        return@run badRequest(request)
                    }
                    stateWrite("read", body.entries, body.read, body.clientSentAt)
                }
                "/entries/starred" -> {
                    val body = body(request, SetStarredRequest.serializer())
                    if (body.entries.size !in 1..ServerLimits.STATE_WRITE_ENTRIES) {
                        return@run badRequest(request)
                    }
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

    private fun MockRequestHandleScope.badRequest(request: HttpRequestData) = run {
        requestLog += "${request.method.value} ${request.url.encodedPath} -> 400"
        respond("{}", HttpStatusCode.BadRequest, json)
    }

    private fun changes(entriesCursor: Long?, entriesSince: Long?, deletionsCursor: Long?): String {
        if (entriesCursor == null && deletionsCursor == null) {
            return encode(
                SyncChanges.serializer(),
                SyncChanges(
                    emptyList(),
                    false,
                    SyncCursors(entries = "$seq", deletions = "$seq"),
                    emptyList(),
                    false,
                ),
            )
        }
        val after = entriesCursor ?: 0
        // Like the server, a change after either counts.
        val since = minOf(after, entriesSince ?: after)
        val changed = visible.filter { it.updatedSeq > after }.sortedBy { it.updatedSeq }
        val page = changed.take(syncPageSize)
        val events = page.flatMap { e ->
            buildList {
                // As the server's entryRowToSyncEvents: a new entry's new_entry and, its state
                // being new too, its entry_state_changed, which alone has its score and positions.
                if (e.createdSeq > since) {
                    add(SyncEvent.NewEntry(e.id, e.origin, e.memberships, e.eventEntry()))
                } else if (e.metadataSeq > since) {
                    add(
                        SyncEvent.EntryUpdated(
                            e.id,
                            com.lionreader.shared.api.EntryMetadata(title = e.id),
                        )
                    )
                }
                if (e.stateSeq > since) {
                    add(
                        SyncEvent.EntryStateChanged(
                            e.id,
                            e.read,
                            e.starred,
                            e.readChangedAt?.let { e.time(it) },
                            e.memberships,
                            e.origin,
                            if (e.read) null else e.eventEntry(),
                            score = e.score,
                            positions = e.positions.toMap(),
                        )
                    )
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
                resyncRequired = false,
            ),
        )
    }

    private fun list(
        sortBy: String?,
        starredOnly: Boolean,
        type: String?,
        subscriptionId: String?,
        cursor: String?,
        limit: Int,
    ): String {
        val matching =
            visible
                .filter { !starredOnly || it.starred }
                // Saved is the Saved subscription's list.
                .filter { type != "saved" || savedSubscriptionId in it.memberships }
                .filter { subscriptionId == null || subscriptionId in it.memberships }
                .filter { sortBy != "readChanged" || it.readChangedAt != null }
                .let { rows ->
                    // With no sort named, a subscription whose members have positions lists by
                    // them, first first, as the server's default; any other list newest first.
                    val byPosition =
                        sortBy == null &&
                            subscriptionId != null &&
                            rows.any { subscriptionId in it.positions }
                    rows.sortedWith(
                        when {
                            sortBy == "readChanged" -> recentlyReadOrder
                            sortBy == "score" -> highestScoreOrder
                            byPosition -> rankedOrder(false) { it.positions[subscriptionId] }
                            else -> newestOrder
                        }
                    )
                }
        val offset = cursor?.toInt() ?: 0
        val page = matching.drop(offset).take(limit)
        val next = (offset + limit).takeIf { it < matching.size }?.toString()
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
                .map {
                    EntryState(
                        it.id,
                        it.read,
                        it.starred,
                        it.readChangedAt?.let { t -> it.time(t) },
                    )
                }
        return encode(
            BulkStateResponse.serializer(),
            BulkStateResponse(states),
        )
    }

    private fun Entry.time(millis: Long) = Instant.fromEpochMilliseconds(millis).toString()

    private fun Entry.eventEntry() =
        EventEntry(
            type = type,
            title = id,
            publishedAt = time(published),
            fetchedAt = time(published),
            read = read,
            starred = starred,
            readChangedAt = readChangedAt?.let { time(it) },
        )

    private fun Entry.listItem() =
        EntryListItem(
            id = id,
            subscriptionId = origin,
            subscriptionIds = memberships,
            type = type,
            title = id,
            publishedAt = time(published),
            fetchedAt = time(published),
            read = read,
            starred = starred,
            readChangedAt = readChangedAt?.let { time(it) },
            score = score,
            positions = positions.toMap(),
        )

    private fun Entry.full() =
        FullEntry(
            id = id,
            subscriptionId = origin,
            subscriptionIds = memberships,
            type = type,
            title = id,
            publishedAt = time(published),
            fetchedAt = time(published),
            read = read,
            starred = starred,
            content = content,
            readChangedAt = readChangedAt?.let { time(it) },
            score = score,
            positions = positions.toMap(),
        )

    private fun <T> encode(serializer: KSerializer<T>, value: T) =
        ApiJson.encodeToString(serializer, value)

    private fun <T> body(request: HttpRequestData, serializer: KSerializer<T>): T =
        ApiJson.decodeFromString(serializer, (request.body as TextContent).text)

    private val json = headersOf(HttpHeaders.ContentType, "application/json")

    /** The server's Recently Read: entries whose read state changed, latest first. */
    fun recentlyRead(): List<String> =
        visible.filter { it.readChangedAt != null }.sortedWith(recentlyReadOrder).map { it.id }

    private val recentlyReadOrder =
        compareByDescending<Entry> { it.readChangedAt }.thenByDescending { it.id }

    private val newestOrder = compareByDescending<Entry> { it.published }.thenByDescending { it.id }

    /**
     * The server's order by a value an entry may lack (`planEntryPage`): those with one by it, ties
     * by date the same way round, then the rest newest first, whichever the direction.
     */
    private fun rankedOrder(descending: Boolean, value: (Entry) -> Double?): Comparator<Entry> {
        val valued =
            compareBy<Entry>({ value(it) }, { it.published }, { it.id }).let {
                if (descending) it.reversed() else it
            }
        return Comparator { a, b ->
            val (x, y) = value(a) to value(b)
            when {
                x != null && y != null -> valued.compare(a, b)
                x != null -> -1
                y != null -> 1
                else -> newestOrder.compare(a, b)
            }
        }
    }

    private val highestScoreOrder = rankedOrder(descending = true) { it.score }

    /** All, highest score first, as the server lists it. */
    fun byScore(lowestFirst: Boolean = false): List<String> =
        visible.sortedWith(rankedOrder(!lowestFirst) { it.score }).map { it.id }

    /** [collection]'s articles, first position first, as the server lists them. */
    fun byPosition(lastFirst: Boolean = false): List<String> =
        visible
            .filter { collection in it.collections }
            .sortedWith(rankedOrder(lastFirst) { it.positions[collection] })
            .map { it.id }

    private companion object {
        val WRITES = setOf("/entries/mark-read", "/entries/starred")
        const val SAVED_SUBSCRIPTION_ID = "saved-subscription"
    }
}
