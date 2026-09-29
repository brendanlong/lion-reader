package com.lionreader.shared.sync

import com.lionreader.shared.api.ApiException
import com.lionreader.shared.api.BulkStateResponse
import com.lionreader.shared.api.FeedType
import com.lionreader.shared.api.LionReaderApi
import com.lionreader.shared.api.ListFilter
import com.lionreader.shared.api.MarkAllReadRequest
import com.lionreader.shared.api.MarkReadRequest
import com.lionreader.shared.api.SetStarredRequest
import com.lionreader.shared.api.StateChange
import com.lionreader.shared.api.SyncEvent
import com.lionreader.shared.api.parseSyncEvent
import com.lionreader.shared.data.LocalStore
import com.lionreader.shared.data.formatMillis
import com.lionreader.shared.data.parseMillis
import com.lionreader.shared.db.LionReaderDatabase
import com.lionreader.shared.db.Outbox_state
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

private const val FLUSH_BATCH = 1000
private const val CONTENT_BATCH = 50

/**
 * Keeps the local store in step with the server: sends the outbox, pulls changes (or the initial
 * window), downloads bodies, and applies retention.
 *
 * Every step is safe to interrupt and repeat: cursors advance only with the data they cover (in one
 * transaction), outbox rows are removed only once the server has accepted them, and replaying a
 * change is harmless because the server resolves read/star conflicts by change time.
 */
class SyncEngine(
    private val api: LionReaderApi,
    db: LionReaderDatabase,
    private val now: () -> Long,
    private val policy: () -> RetentionPolicy,
) {
    private val store = LocalStore(db)
    private val db = store.db
    private val mutex = Mutex()

    /** A full sync. Throws on network/server failure; retry later. */
    suspend fun sync(downloadContent: Boolean = true) = mutex.withLock {
        flush()
        if (store.cursors == null) bootstrap()
        pull()
        if (downloadContent) downloadContent()
        evict()
    }

    /** Sends unsent changes only (quick, after the user acts). */
    suspend fun flushOutbox() = mutex.withLock { flush() }

    /** Downloads one entry's body now (opening an entry the sync hasn't reached). */
    suspend fun ensureContent(entryId: String) {
        if (db.entryQueries.selectById(entryId).executeAsOneOrNull()?.content != null) return
        fetchBodies(listOf(entryId))
    }

    /** Forgets all synced data, e.g. on sign-out. */
    suspend fun reset() = mutex.withLock { db.transaction { store.clearAll() } }

    // ---- Outbox ----------------------------------------------------------

    private suspend fun flush() {
        for (op in db.outboxQueries.selectMarkAll().executeAsList()) {
            val sent = send {
                api.markAllRead(
                    MarkAllReadRequest(
                        subscriptionId = op.subscription_id,
                        tagId = op.tag_id,
                        starredOnly = op.starred_only == 1L,
                        type = if (op.saved_only == 1L) FeedType.SAVED else null,
                        // `before` is inclusive at microsecond precision;
                        // round up so the newest seen entry is included.
                        before = formatMillis(op.before + 1),
                        changedAt = formatMillis(op.changed_at),
                        clientSentAt = formatMillis(now()),
                    )
                )
            }
            if (sent != Sent.RETRY) db.outboxQueries.deleteMarkAll(op.id)
        }

        val ops = db.outboxQueries.selectStates().executeAsList()
        val groups = ops.groupBy { it.field_ to (it.value_ == 1L) }
        for ((key, group) in groups) {
            val (field, value) = key
            for (batch in group.chunked(FLUSH_BATCH)) {
                val changes = batch.map { StateChange(it.entry_id, formatMillis(it.changed_at)) }
                var response: BulkStateResponse? = null
                val sent = send {
                    response =
                        if (field == "read") {
                            api.markRead(MarkReadRequest(changes, value, formatMillis(now())))
                        } else {
                            api.setStarred(SetStarredRequest(changes, value, formatMillis(now())))
                        }
                }
                if (sent == Sent.RETRY) continue
                db.transaction {
                    response?.let { applyStateResponse(it, batch) }
                    batch.forEach {
                        db.outboxQueries.deleteStateIfUnchanged(
                            it.entry_id,
                            it.field_,
                            it.changed_at,
                        )
                    }
                }
            }
        }
    }

    private fun applyStateResponse(response: BulkStateResponse, batch: List<Outbox_state>) {
        val returned = response.entries.associateBy { it.id }
        for (op in batch) {
            val state = returned[op.entry_id]
            if (state == null) {
                // No longer visible to the user (deleted, or unsubscribed and
                // unstarred): drop the local copy along with the change.
                store.deleteEntry(op.entry_id)
            } else {
                db.entryQueries.updateServerState(
                    if (state.read) 1 else 0,
                    if (state.starred) 1 else 0,
                    state.id,
                )
            }
        }
        response.counts?.let(store::applyCounts)
    }

    private enum class Sent {
        OK,
        /** The server rejected the request itself; drop it rather than retry forever. */
        DROPPED,
        RETRY,
    }

    /**
     * Runs one outbox request. A request the server rejects outright is dropped so one bad item
     * can't stall the queue; anything else (network, 401, 429, 5xx) keeps it for the next flush.
     */
    private suspend fun send(block: suspend () -> Unit): Sent =
        try {
            block()
            Sent.OK
        } catch (e: ApiException) {
            if (e.isPermanent) Sent.DROPPED else throw e
        }

    // ---- Pull ------------------------------------------------------------

    private suspend fun bootstrap() {
        // Cursors first: anything that changes during the download is replayed
        // by the next pull, which is harmless.
        val start = api.syncChanges(null).cursors
        val policy = policy()
        val windowStart = now() - policy.windowMillis

        val subscriptions = buildList {
            var cursor: String? = null
            do {
                val page = api.listSubscriptions(cursor)
                addAll(page.items)
                cursor = page.nextCursor
            } while (cursor != null)
        }
        val tags = api.listTags()
        val counts = ListFilter.entries.associateWith { api.unreadCount(it) }

        val entries = buildList {
            for (filter in ListFilter.entries) {
                var cursor: String? = null
                var fetched = 0
                do {
                    val page = api.listEntries(filter, cursor)
                    addAll(page.items)
                    fetched += page.items.size
                    cursor = page.nextCursor
                    val pastWindow =
                        filter == ListFilter.ALL &&
                            page.items.lastOrNull()?.let {
                                parseMillis(it.publishedAt ?: it.fetchedAt) < windowStart
                            } == true
                } while (cursor != null && fetched < policy.bootstrapMaxEntries && !pastWindow)
            }
        }

        db.transaction {
            store.clearSynced()
            subscriptions.forEach(store::upsertSubscription)
            tags.items.forEach(store::upsertTag)
            store.setListCount("all", counts.getValue(ListFilter.ALL))
            store.setListCount("starred", counts.getValue(ListFilter.STARRED))
            store.setListCount("saved", counts.getValue(ListFilter.SAVED))
            entries.forEach(store::upsertEntry)
            store.cursors = start
        }
    }

    private suspend fun pull() {
        while (true) {
            val cursors = store.cursors ?: return
            val changes = api.syncChanges(cursors)
            if (changes.resyncRequired) {
                db.transaction { store.cursors = null }
                bootstrap()
                continue
            }
            val events = changes.events.mapNotNull(::parseSyncEvent)
            val missingStarred = mutableListOf<String>()
            val resubscribed = mutableListOf<String>()
            db.transaction {
                for (event in events) apply(event, missingStarred, resubscribed)
                changes.deletions.forEach { store.deleteEntry(it.entryId) }
                store.cursors = changes.cursors
            }
            if (missingStarred.isNotEmpty()) fetchBodies(missingStarred)
            for (subscriptionId in resubscribed) {
                // A resubscribed feed's old entries predate the cursor, so no
                // delta will bring them back.
                val page = api.listEntries(ListFilter.ALL, null, subscriptionId)
                db.transaction { page.items.forEach(store::upsertEntry) }
            }
            if (!changes.hasMore) return
        }
    }

    private fun apply(
        event: SyncEvent,
        missingStarred: MutableList<String>,
        resubscribed: MutableList<String>,
    ) {
        when (event) {
            is SyncEvent.NewEntry -> {
                event.entry?.let {
                    store.upsertEntry(
                        event.entryId,
                        event.subscriptionId,
                        event.feedId,
                        event.feedType,
                        it.url,
                        it.title,
                        it.author,
                        it.summary,
                        it.siteName,
                        it.feedTitle,
                        it.publishedAt,
                        it.fetchedAt,
                        it.read ?: false,
                        it.starred ?: false,
                    )
                }
                event.counts?.let(store::applyCounts)
            }
            is SyncEvent.EntryUpdated ->
                with(event.metadata) {
                    val published = publishedAt?.let(::parseMillis)
                    db.entryQueries.updateMetadata(
                        title,
                        author,
                        summary,
                        url,
                        published,
                        published,
                        event.entryId,
                    )
                }
            is SyncEvent.EntryStateChanged -> {
                val entry = event.entry
                when {
                    store.entryExists(event.entryId) ->
                        db.entryQueries.updateServerState(
                            if (event.read) 1 else 0,
                            if (event.starred) 1 else 0,
                            event.entryId,
                        )
                    entry != null && event.feedType != null ->
                        store.upsertEntry(
                            event.entryId,
                            event.subscriptionId,
                            event.feedId,
                            event.feedType,
                            entry.url,
                            entry.title,
                            entry.author,
                            entry.summary,
                            entry.siteName,
                            entry.feedTitle,
                            entry.publishedAt,
                            entry.fetchedAt,
                            event.read,
                            event.starred,
                        )
                    event.starred -> missingStarred += event.entryId
                }
                store.applyCounts(event.counts)
            }
            is SyncEvent.SubscriptionCreated -> {
                with(event) {
                    store.upsertSubscription(
                        subscription.id,
                        feed.id,
                        feed.type,
                        subscription.customTitle ?: feed.title,
                        feed.url,
                        feed.siteUrl,
                        subscription.unreadCount,
                        false,
                        subscription.tags,
                    )
                    counts?.let(store::applyCounts)
                }
                resubscribed += event.subscription.id
            }
            is SyncEvent.SubscriptionUpdated -> {
                db.subscriptionQueries.updateSubscriptionTitle(
                    event.customTitle,
                    event.subscriptionId,
                )
                store.setSubscriptionTags(event.subscriptionId, event.tags)
            }
            is SyncEvent.SubscriptionDeleted -> {
                store.deleteSubscription(event.subscriptionId)
                event.counts?.let(store::applyCounts)
            }
            is SyncEvent.TagCreated -> store.upsertTag(event.tag)
            is SyncEvent.TagUpdated -> store.upsertTag(event.tag)
            is SyncEvent.TagDeleted -> store.deleteTag(event.tagId)
        }
    }

    // ---- Bodies and retention -------------------------------------------

    private suspend fun downloadContent() {
        val budget = policy().contentBudgetBytes
        while (db.entryQueries.contentSize().executeAsOne() < budget) {
            val ids = db.entryQueries.selectMissingContent(CONTENT_BATCH.toLong()).executeAsList()
            if (ids.isEmpty()) return
            fetchBodies(ids)
        }
    }

    private suspend fun fetchBodies(ids: List<String>) {
        val fetched = api.getEntries(ids)
        val time = now()
        db.transaction {
            fetched.forEach { store.upsertEntry(it, time) }
            // Asked for but not returned: the user can no longer see it.
            val returned = fetched.map { it.id }.toSet()
            ids.filterNot { it in returned }.forEach(store::deleteEntry)
        }
    }

    private fun evict() {
        val policy = policy()
        db.transaction {
            db.entryQueries.evictOutsideWindow(now() - policy.windowMillis)
            db.entryQueries.evictBeyondCount(policy.maxEntries.toLong())
            var size = db.entryQueries.contentSize().executeAsOne()
            if (size > policy.contentBudgetBytes) {
                for (candidate in db.entryQueries.contentEvictionCandidates().executeAsList()) {
                    if (size <= policy.contentBudgetBytes) break
                    db.entryQueries.dropContent(candidate.id)
                    size -= candidate.size ?: 0
                }
            }
        }
    }
}
