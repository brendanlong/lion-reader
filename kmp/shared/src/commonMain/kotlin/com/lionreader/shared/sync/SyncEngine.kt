package com.lionreader.shared.sync

import com.lionreader.shared.api.ApiException
import com.lionreader.shared.api.ApiFailure
import com.lionreader.shared.api.COLLECTION_TYPE
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.ListFilter
import com.lionreader.shared.api.MarkReadRequest
import com.lionreader.shared.api.SetStarredRequest
import com.lionreader.shared.api.StateChange
import com.lionreader.shared.api.Subscription
import com.lionreader.shared.api.SyncChanges
import com.lionreader.shared.api.SyncCursors
import com.lionreader.shared.api.SyncEvent
import com.lionreader.shared.api.failure
import com.lionreader.shared.api.parseSyncEvent
import com.lionreader.shared.data.formatMillis
import com.lionreader.shared.data.parseMillis
import com.lionreader.shared.db.LionReaderDatabase
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private const val FLUSH_BATCH = 1000
private const val CONTENT_BATCH = 50
private const val ENSURE_ATTEMPTS = 3
private const val RECENTLY_READ_PAGE = 100
private const val RECENTLY_READ_REFRESH = 20

/**
 * Keeps the local store in step with the server: sends the outbox, pulls changes (or the initial
 * window), downloads bodies, and applies retention.
 *
 * Every step fetches first and then commits through [SyncWriter], which can't reach the network. So
 * every step is safe to interrupt and repeat: cursors advance only with the data they cover, outbox
 * rows are removed only once the server has accepted them, and replaying a change is harmless
 * because the server resolves read/star conflicts by change time.
 */
class SyncEngine(
    private val api: LionReaderApi,
    db: LionReaderDatabase,
    private val now: () -> Long,
    private val policy: () -> RetentionPolicy,
) {
    private val writer = SyncWriter(db)
    private val outboxQueries = db.outboxQueries

    /** Serializes everything that reads or writes cursors, state, or the outbox. */
    private val mutex = Mutex()

    /**
     * Serializes the background body downloads, which run outside [mutex] so a long download never
     * holds up a refresh or a flush. Downloads only write `entry_body`, guarded by body version
     * (see [SyncWriter.storeBodies]), so they can't race the sync or each other.
     */
    private val contentMutex = Mutex()

    /**
     * A full sync: send, pull, then (if [downloadContent]) article bodies. Throws on network/server
     * failure (a failed send only once the rest is done); retry later.
     */
    suspend fun sync(downloadContent: Boolean = true) {
        val flushFailure = mutex.withLock {
            tryFlush().also {
                if (writer.cursors == null) bootstrap()
                else if (!writer.collectionsListed) listCollections(listSubscriptions())
                pull()
                refreshRecentlyRead(policy())
                writer.evict(policy(), now())
            }
        }
        if (downloadContent) {
            contentMutex.withLock {
                downloadContent()
                mutex.withLock { writer.evict(policy(), now()) }
            }
        }
        flushFailure?.let { throw it }
    }

    /**
     * Sends unsent changes (quick, after the user acts), then pulls what changed elsewhere
     * meanwhile. Throws if either fails, pulling even when the send did.
     */
    suspend fun flushOutbox() = mutex.withLock {
        val flushFailure = tryFlush()
        pull()
        flushFailure?.let { throw it }
    }

    /**
     * Downloads one entry's body now (opening an entry the sync hasn't reached); whether the entry
     * now has one. Not behind [contentMutex]: the user is waiting, and a background download can
     * take minutes.
     */
    suspend fun ensureContent(entryId: String): Boolean {
        // Again if the entry was edited mid-download, which discards the old body.
        repeat(ENSURE_ATTEMPTS) {
            if (writer.hasBody(entryId)) return true
            val version = writer.bodyVersion(entryId) ?: return false
            fetchBodies(mapOf(entryId to version))
        }
        return writer.hasBody(entryId)
    }

    /** Whether the server can summarize for this user (it has an AI provider to use). */
    suspend fun summariesAvailable(): Boolean = api.summarizationAvailable()

    /**
     * Gets the entry's AI summary from the server (which caches it) and keeps it on the device.
     * Throws on network/server failure, and when the server has nothing to show.
     */
    suspend fun summarize(entryId: String) {
        val version = writer.bodyVersion(entryId) ?: return
        val summary = api.summarize(entryId)
        check(summary.isNotBlank()) { "Empty summary" }
        writer.storeSummary(entryId, summary, version)
    }

    // ---- Outbox ----------------------------------------------------------

    /**
     * [flush]'s failure, returned rather than thrown: changes that can't be sent yet mustn't stop
     * the device from receiving everyone else's.
     */
    private suspend fun tryFlush(): Exception? =
        try {
            flush()
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            e
        }

    private suspend fun flush() {
        val ops = outboxQueries.selectStates().executeAsList()
        for ((key, group) in ops.groupBy { it.field_ to (it.value_ == 1L) }) {
            val (field, value) = key
            for (batch in group.chunked(FLUSH_BATCH)) {
                val changes = batch.map { StateChange(it.entry_id, formatMillis(it.changed_at)) }
                val response = sendOrReject {
                    if (field == "read") {
                        api.markRead(MarkReadRequest(changes, value, formatMillis(now())))
                    } else {
                        api.setStarred(SetStarredRequest(changes, value, formatMillis(now())))
                    }
                }
                writer.commitSent(batch, response)
            }
        }
    }

    /**
     * Runs one outbox request: its result, or null when the request itself can never succeed
     * ([ApiFailure.Invalid]), so it's dropped. Anything else throws, keeping the change for the
     * next flush: a refusal (401, 403…) isn't shown to be about the change, and the change is the
     * user's.
     */
    private suspend fun <T> sendOrReject(request: suspend () -> T): T? =
        try {
            request()
        } catch (e: ApiException) {
            if (e.failure() is ApiFailure.Invalid) null else throw e
        }

    // ---- Pull ------------------------------------------------------------

    /**
     * The first download, newest first, saved page by page so the lists fill in while older entries
     * are still arriving. Its start cursors are kept until it finishes, so an interrupted bootstrap
     * resumes (re-listing the pages, which is idempotent) instead of starting over.
     */
    private suspend fun bootstrap() {
        // Cursors first: anything that changes during the download is replayed
        // by the next pull, which is harmless.
        val start =
            writer.bootstrapCursors ?: api.syncChanges(null).cursors.also(writer::startBootstrap)
        val policy = policy()
        val windowStart = now() - policy.windowMillis

        val subscriptions = listSubscriptions()
        writer.saveTags(api.listTags())
        listCollections(subscriptions)

        for (filter in ListFilter.entries) {
            var cursor: String? = null
            var fetched = 0
            do {
                val page = api.listEntries(filter, cursor)
                writer.saveEntries(page.items)
                fetched += page.items.size
                cursor = page.nextCursor
                val pastWindow =
                    filter == ListFilter.ALL &&
                        page.items.lastOrNull()?.let {
                            parseMillis(it.publishedAt ?: it.fetchedAt) < windowStart
                        } == true
            } while (cursor != null && fetched < policy.bootstrapMaxEntries && !pastWindow)
        }

        writer.finishBootstrap(start)
    }

    private suspend fun listSubscriptions(): List<Subscription> {
        val all = mutableListOf<Subscription>()
        var cursor: String? = null
        do {
            val page = api.listSubscriptions(cursor)
            writer.saveSubscriptions(page.items)
            all += page.items
            cursor = page.nextCursor
        } while (cursor != null)
        return all
    }

    /**
     * Every collection's articles (whatever their age: retention keeps them), with their
     * membership. Done once per database (a bootstrap, or the first sync of a database that
     * predates collections); after that `sync.changes` reports each change to an entry's
     * collections.
     */
    private suspend fun listCollections(subscriptions: List<Subscription>) {
        for (collection in subscriptions.filter { it.type == COLLECTION_TYPE }) {
            var cursor: String? = null
            do {
                val page = api.listEntries(ListFilter.ALL, cursor, collection.id)
                writer.saveCollectionPage(collection.id, page.items, first = cursor == null)
                cursor = page.nextCursor
            } while (cursor != null)
        }
        writer.finishCollections()
    }

    /**
     * The server's Recently Read. The web marks an entry read again whenever it's opened, which
     * moves it there without counting as a change to sync (#1118), so every sync pages through it
     * until what it had seen last time: the first sync, back through the retention window. Never
     * more than retention keeps.
     */
    private suspend fun refreshRecentlyRead(policy: RetentionPolicy) {
        val windowStart = now() - policy.windowMillis
        val until = maxOf(writer.recentlyReadSeen ?: Long.MIN_VALUE, windowStart)
        var newest: Long? = null
        var fetched = 0
        var cursor: String? = null
        do {
            val limit = if (fetched == 0) RECENTLY_READ_REFRESH else RECENTLY_READ_PAGE
            val page = api.listRecentlyRead(cursor, limit)
            val times = page.items.mapNotNull { it.readChangedAt?.let(::parseMillis) }
            writer.saveRecentlyRead(page.items, windowStart)
            newest = newest ?: times.firstOrNull()
            fetched += page.items.size
            cursor = page.nextCursor
        } while (
            cursor != null &&
                (times.lastOrNull() ?: until) > until &&
                fetched < policy.maxReadEntries
        )
        newest?.let { writer.recentlyReadSeen = it }
    }

    private suspend fun pull() {
        while (true) {
            val cursors = writer.cursors ?: return
            // Every page of a catch-up is sent where it started, which the
            // server classifies changes against: pages are ordered by an
            // entry's latest change, so against a later page's own cursor its
            // creation or an edit would go unreported (#1663).
            val start = writer.catchUpStart ?: cursors
            val changes = api.syncChanges(cursors, start)
            if (changes.resyncRequired) {
                writer.forgetCursors()
                bootstrap()
                continue
            }
            writer.commitPage(
                fetchPage(changes.events.mapNotNull(::parseSyncEvent), changes, start),
                now(),
            )
            if (!changes.hasMore) return
        }
    }

    /** Everything a page needs beyond its events, fetched before it commits. */
    private suspend fun fetchPage(
        events: List<SyncEvent>,
        changes: SyncChanges,
        start: SyncCursors,
    ): PulledPage {
        val mentioned = events.mapNotNull {
            when (it) {
                is SyncEvent.NewEntry -> it.entryId
                is SyncEvent.EntryUpdated -> it.entryId
                is SyncEvent.EntryStateChanged -> it.entryId
                else -> null
            }
        }
        // Spam comes without its data, so that clients leave it out as the
        // server's lists do: a new entry without it, or an unread one changed.
        // (So with "show spam" on, spam arrives with the first download but
        // not from later syncs: the events don't say the user wants it.)
        val spam =
            events
                .mapNotNull {
                    when {
                        it is SyncEvent.NewEntry && it.entry == null -> it.entryId
                        it is SyncEvent.EntryStateChanged && !it.read && it.entry == null ->
                            it.entryId
                        else -> null
                    }
                }
                .toSet()
        // A new-entry event with its data is complete for an entry the device
        // lacks. One it already has was listed by a bootstrap that began
        // before the entry was created, and may have been edited since its
        // body was downloaded (#1680), so it's fetched whole.
        val newIds = events.filterIsInstance<SyncEvent.NewEntry>().map { it.entryId }.toSet()
        val complete =
            events
                .filterIsInstance<SyncEvent.NewEntry>()
                .filter { it.entry != null && !writer.entryExists(it.entryId) }
                .map { it.entryId }
        val ids =
            mentioned.distinct().filter {
                it !in spam && it !in complete && (it in newIds || !writer.entryExists(it))
            }
        return PulledPage(
            events = events,
            deletedIds = changes.deletions.map { it.entryId },
            collectionMemberships = changes.collectionMemberships,
            cursors = changes.cursors,
            hasMore = changes.hasMore,
            catchUpStart = start,
            fetchedEntries = api.getEntries(ids),
            resubscribedEntries =
                events.filterIsInstance<SyncEvent.SubscriptionCreated>().flatMap {
                    api.listEntries(ListFilter.ALL, null, it.subscription.id).items
                },
        )
    }

    // ---- Bodies ----------------------------------------------------------

    private suspend fun downloadContent() {
        val budget = policy().contentBudgetBytes
        var size = writer.bodySize()
        while (size < budget) {
            val versions = writer.missingBodies(CONTENT_BATCH.toLong())
            if (versions.isEmpty()) return
            size += fetchBodies(versions)
        }
    }

    /** Downloads bodies for entries at the given body versions. */
    private suspend fun fetchBodies(versions: Map<String, Long>): Long {
        val fetched = api.getEntries(versions.keys.toList())
        val returned = fetched.map { it.id }.toSet()
        return writer.storeBodies(
            fetched,
            versions.keys.filterNot { it in returned },
            versions,
            now(),
        )
    }
}
