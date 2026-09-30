package com.lionreader.shared.sync

import com.lionreader.shared.api.BulkStateResponse
import com.lionreader.shared.api.EntryListItem
import com.lionreader.shared.api.FullEntry
import com.lionreader.shared.api.Subscription
import com.lionreader.shared.api.SyncCursors
import com.lionreader.shared.api.SyncEvent
import com.lionreader.shared.api.TagList
import com.lionreader.shared.data.LocalStore
import com.lionreader.shared.data.parseMillis
import com.lionreader.shared.data.searchText
import com.lionreader.shared.db.LionReaderDatabase
import com.lionreader.shared.db.Outbox_state

/** One `sync.changes` page with everything it needs already fetched. */
internal class PulledPage(
    val events: List<SyncEvent>,
    val deletedIds: List<String>,
    val cursors: SyncCursors,
    val hasMore: Boolean,
    /**
     * Entries fetched whole, as the server has them now: ones the events mention that aren't on the
     * device, and ones that are but whose edits the events may not report (new-entry events, and
     * every event while a catch-up is past its first page). See [SyncEngine] `fetchPage`.
     */
    val fetchedEntries: List<FullEntry>,
    /** Older entries of feeds the page resubscribes to (they predate the cursor). */
    val resubscribedEntries: List<EntryListItem>,
)

/**
 * Every write the sync makes, each one transaction. Deliberately has no API and nothing here
 * suspends: whatever a commit needs is fetched before it by [SyncEngine], so a cursor can never be
 * committed ahead of data a later request was supposed to bring.
 *
 * Table ownership: `entry` state and metadata, subscriptions, tags and cursors are written here
 * * under the sync lock; bodies only by [storeBodies] and summaries only by [storeSummary] (both
 *   outside the lock, version-guarded, and deleted here with their entry); the outbox by `Reader`
 *   (and cleared here once sent).
 */
internal class SyncWriter(private val db: LionReaderDatabase) {
    private val store = LocalStore(db)

    val cursors: SyncCursors?
        get() = store.cursors

    val bootstrapCursors: SyncCursors?
        get() = store.bootstrapCursors

    fun entryExists(id: String): Boolean = store.entryExists(id)

    // ---- Bootstrap -------------------------------------------------------

    fun startBootstrap(start: SyncCursors) = db.transaction {
        store.clearSynced()
        store.bootstrapCursors = start
    }

    fun saveSubscriptions(items: List<Subscription>) = db.transaction {
        items.forEach(store::upsertSubscription)
    }

    fun saveTags(tags: TagList) = db.transaction { tags.items.forEach(store::upsertTag) }

    fun saveEntries(items: List<EntryListItem>) = db.transaction {
        items.forEach(store::upsertEntry)
    }

    fun finishBootstrap(start: SyncCursors) = db.transaction {
        store.cursors = start
        store.bootstrapCursors = null
    }

    /** A resync starts over from a fresh bootstrap (the outbox is kept). */
    fun forgetCursors() = db.transaction { store.cursors = null }

    // ---- Pull ------------------------------------------------------------

    fun commitPage(page: PulledPage, now: Long) {
        val texts = searchTexts(page.fetchedEntries)
        db.transaction { commitPageInTransaction(page, texts, now) }
    }

    private fun commitPageInTransaction(page: PulledPage, texts: Map<String, String>, now: Long) {
        page.deletedIds.forEach(store::deleteEntry)
        page.events.forEach(::apply)
        for (entry in page.fetchedEntries) {
            store.upsertEntry(
                entry.id,
                entry.subscriptionId,
                entry.feedId,
                entry.type,
                entry.url,
                entry.title,
                entry.author,
                entry.summary,
                entry.siteName,
                entry.feedTitle,
                entry.publishedAt,
                entry.fetchedAt,
                entry.read,
                entry.starred,
            )
            // The fetched body is current: it replaces the old one and wins
            // over any download already in flight. A summary goes unless the
            // body is the one it summarized.
            val old = db.bodyQueries.content(entry.id).executeAsOneOrNull()
            if (old != (entry.displayContent ?: "")) {
                db.summaryQueries.deleteForEntry(entry.id)
            }
            db.entryQueries.bumpBodyVersion(entry.id)
        }
        val versions = page.fetchedEntries.associate { it.id to (bodyVersion(it.id) ?: 0L) }
        storeBodiesInTransaction(page.fetchedEntries, texts, emptyList(), versions, now)
        page.resubscribedEntries.forEach(store::upsertEntry)
        store.cursors = page.cursors
        store.catchUpInProgress = page.hasMore
    }

    val catchUpInProgress: Boolean
        get() = store.catchUpInProgress

    private fun apply(event: SyncEvent) {
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
                    // The body may have changed too; download it again, and
                    // reject any download that started before now. A summary
                    // of the old text goes with it.
                    db.bodyQueries.deleteForEntry(event.entryId)
                    db.summaryQueries.deleteForEntry(event.entryId)
                    db.entryQueries.bumpBodyVersion(event.entryId)
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
                }
            }
            is SyncEvent.SubscriptionCreated ->
                with(event) {
                    store.upsertSubscription(
                        subscription.id,
                        feed.id,
                        feed.type,
                        subscription.customTitle ?: feed.title,
                        feed.url,
                        feed.siteUrl,
                        false,
                        subscription.tags,
                    )
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
            }
            is SyncEvent.TagCreated -> store.upsertTag(event.tag)
            is SyncEvent.TagUpdated -> store.upsertTag(event.tag)
            is SyncEvent.TagDeleted -> store.deleteTag(event.tagId)
        }
    }

    // ---- Outbox ----------------------------------------------------------

    /**
     * Records a sent batch: the server's answer becomes the local server state, and each change is
     * removed unless the user changed it again meanwhile. A null [response] means the server
     * rejected the batch; the changes are dropped so one bad item can't stall the queue.
     */
    fun commitSent(batch: List<Outbox_state>, response: BulkStateResponse?) = db.transaction {
        if (response != null) {
            val returned = response.entries.associateBy { it.id }
            for (op in batch) {
                val state = returned[op.entry_id]
                if (state == null) {
                    // No longer visible to the user (deleted, or unsubscribed
                    // and unstarred): drop the local copy with the change.
                    store.deleteEntry(op.entry_id)
                } else {
                    db.entryQueries.updateServerState(
                        if (state.read) 1 else 0,
                        if (state.starred) 1 else 0,
                        state.id,
                    )
                }
            }
        }
        batch.forEach {
            db.outboxQueries.deleteStateIfUnchanged(it.entry_id, it.field_, it.changed_at)
        }
    }

    // ---- Bodies and retention -------------------------------------------

    /**
     * Stores downloaded bodies, and an empty one for each [missing] id (asked for but not returned:
     * no longer visible) so it isn't requested again — each only if its entry is still at the
     * [versions] it had when the download started. Never touches `entry`, which is why it's safe
     * outside the sync lock. Returns the characters stored.
     */
    fun storeBodies(
        fetched: List<FullEntry>,
        missing: List<String>,
        versions: Map<String, Long>,
        now: Long,
    ): Long {
        val texts = searchTexts(fetched)
        return db.transactionWithResult {
            storeBodiesInTransaction(fetched, texts, missing, versions, now)
        }
    }

    /** Each body's [searchText], worked out before the write transaction to keep it short. */
    private fun searchTexts(entries: List<FullEntry>): Map<String, String> = entries.associate {
        it.id to searchText(it.displayContent ?: "")
    }

    private fun storeBodiesInTransaction(
        fetched: List<FullEntry>,
        texts: Map<String, String>,
        missing: List<String>,
        versions: Map<String, Long>,
        now: Long,
    ): Long {
        var stored = 0L
        for (entry in fetched) {
            val version = versions[entry.id] ?: continue
            val content = entry.displayContent ?: ""
            val text = texts.getValue(entry.id)
            // The search index's copy of the text counts against the budget too.
            val size = (content.length + text.length).toLong()
            db.bodyQueries.putIfCurrent(entry.id, content, size, now, text, version)
            stored += size
        }
        missing.forEach { id ->
            versions[id]?.let { db.bodyQueries.putIfCurrent(id, "", 0, now, "", it) }
        }
        return stored
    }

    /** The entry's body version, or null when it isn't on the device. */
    fun bodyVersion(entryId: String): Long? =
        db.entryQueries.bodyVersion(entryId).executeAsOneOrNull()

    fun bodySize(): Long = db.bodyQueries.totalSize().executeAsOne()

    /** Entries needing a body, with the body version to download them at. */
    fun missingBodies(limit: Long): Map<String, Long> =
        db.entryQueries.selectMissingContent(limit).executeAsList().associate {
            it.id to it.body_version
        }

    fun hasBody(entryId: String): Boolean =
        db.entryQueries.selectById(entryId).executeAsOneOrNull()?.content != null

    fun evict(policy: RetentionPolicy, now: Long) = db.transaction {
        db.entryQueries.evictOutsideWindow(now - policy.windowMillis)
        db.entryQueries.evictBeyondCount(policy.maxReadEntries.toLong())
        db.bodyQueries.pruneOrphans()
        db.summaryQueries.pruneOrphans()
        var size = db.bodyQueries.totalSize().executeAsOne()
        if (size > policy.contentBudgetBytes) {
            val openedSince = now - RECENTLY_OPENED_MILLIS
            for (candidate in db.bodyQueries.evictionCandidates(openedSince).executeAsList()) {
                if (size <= policy.contentBudgetBytes) break
                db.bodyQueries.deleteForEntry(candidate.entry_id)
                size -= candidate.size
            }
        }
    }

    fun clearAll() = db.transaction { store.clearAll() }

    /** Keeps a summary the user asked for, if its entry is still at [bodyVersion]. */
    fun storeSummary(entryId: String, html: String, bodyVersion: Long) =
        db.summaryQueries.putIfCurrent(entryId, html, bodyVersion)
}

private const val RECENTLY_OPENED_MILLIS = 24L * 60 * 60 * 1000
