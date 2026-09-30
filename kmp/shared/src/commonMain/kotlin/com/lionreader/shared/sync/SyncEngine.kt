package com.lionreader.shared.sync

import com.lionreader.shared.api.ApiException
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.ListFilter
import com.lionreader.shared.api.MarkReadRequest
import com.lionreader.shared.api.SetStarredRequest
import com.lionreader.shared.api.StateChange
import com.lionreader.shared.api.SyncChanges
import com.lionreader.shared.api.SyncEvent
import com.lionreader.shared.api.parseSyncEvent
import com.lionreader.shared.data.formatMillis
import com.lionreader.shared.data.parseMillis
import com.lionreader.shared.db.LionReaderDatabase
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private const val FLUSH_BATCH = 1000
private const val CONTENT_BATCH = 50
private const val ENSURE_ATTEMPTS = 3

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
     * failure; retry later.
     */
    suspend fun sync(downloadContent: Boolean = true) {
        mutex.withLock {
            flush()
            if (writer.cursors == null) bootstrap()
            pull()
            writer.evict(policy(), now())
        }
        if (downloadContent) {
            contentMutex.withLock {
                downloadContent()
                mutex.withLock { writer.evict(policy(), now()) }
            }
        }
    }

    /**
     * Sends unsent changes (quick, after the user acts), then pulls what changed elsewhere
     * meanwhile.
     */
    suspend fun flushOutbox() = mutex.withLock {
        flush()
        pull()
    }

    /**
     * Downloads one entry's body now (opening an entry the sync hasn't reached). Not behind
     * [contentMutex]: the user is waiting, and a background download can take minutes.
     */
    suspend fun ensureContent(entryId: String) {
        // Again if the entry was edited mid-download, which discards the old body.
        repeat(ENSURE_ATTEMPTS) {
            if (writer.hasBody(entryId)) return
            val version = writer.bodyVersion(entryId) ?: return
            fetchBodies(mapOf(entryId to version))
        }
    }

    /** Forgets all synced data and unsent changes. */
    suspend fun reset() = mutex.withLock { writer.clearAll() }

    // ---- Outbox ----------------------------------------------------------

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
     * Runs one outbox request: its result, or null when the server rejected the request itself (it
     * would never succeed, so it's dropped). Anything else (network, 401, 429, 5xx) throws, keeping
     * the change for the next flush.
     */
    private suspend fun <T> sendOrReject(request: suspend () -> T): T? =
        try {
            request()
        } catch (e: ApiException) {
            if (e.isPermanent) null else throw e
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

        var subscriptionCursor: String? = null
        do {
            val page = api.listSubscriptions(subscriptionCursor)
            writer.saveSubscriptions(page.items)
            subscriptionCursor = page.nextCursor
        } while (subscriptionCursor != null)
        writer.saveTags(api.listTags())

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

    private suspend fun pull() {
        while (true) {
            val cursors = writer.cursors ?: return
            val changes = api.syncChanges(cursors)
            if (changes.resyncRequired) {
                writer.forgetCursors()
                bootstrap()
                continue
            }
            writer.commitPage(
                fetchPage(changes.events.mapNotNull(::parseSyncEvent), changes),
                now(),
            )
            if (!changes.hasMore) return
        }
    }

    /** Everything a page needs beyond its events, fetched before it commits. */
    private suspend fun fetchPage(events: List<SyncEvent>, changes: SyncChanges): PulledPage {
        val mentioned = events.mapNotNull {
            when (it) {
                is SyncEvent.NewEntry -> it.entryId
                is SyncEvent.EntryUpdated -> it.entryId
                is SyncEvent.EntryStateChanged -> it.entryId
                else -> null
            }
        }
        // The server classifies an entry's changes against each page's own
        // cursor, but pages are ordered by an entry's latest change. So past
        // the first page of a catch-up, an entry edited and then changed again
        // can arrive as a state change only, and one created and then changed
        // as an update rather than new. Fetching whole every entry the device
        // lacks — and, on those later pages, every one it has — keeps it
        // exact. (A single page, the usual case, needs only the former.)
        val refetch = writer.catchUpInProgress
        // A new-entry event with its data is already complete.
        val complete =
            events
                .filterIsInstance<SyncEvent.NewEntry>()
                .filter { it.entry != null }
                .map { it.entryId }
        val ids =
            mentioned.distinct().filter { it !in complete && (refetch || !writer.entryExists(it)) }
        return PulledPage(
            events = events,
            deletedIds = changes.deletions.map { it.entryId },
            cursors = changes.cursors,
            hasMore = changes.hasMore,
            fetchedEntries = if (ids.isEmpty()) emptyList() else api.getEntries(ids),
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
