package com.lionreader.shared.sync

import com.lionreader.shared.api.BulkStateResponse
import com.lionreader.shared.api.CollectionMembership
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
    val collectionMemberships: List<CollectionMembership>,
    val cursors: SyncCursors,
    val hasMore: Boolean,
    /** The cursors the catch-up this page is part of started from. */
    val catchUpStart: SyncCursors,
    /**
     * Entries fetched whole, as the server has them now: ones the events mention that aren't on the
     * device, and ones it has that new-entry events mention. See [SyncEngine] `fetchPage`.
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
 * Table ownership: `entry` state and metadata, collection membership, subscriptions, tags and
 * cursors are written here under the sync lock; bodies only by [storeBodies] and summaries only by
 * [storeSummary] and, when the body they summarized is replaced, [storeBodies] (outside the lock,
 * version-guarded, and deleted here with their entry); the outbox by `Reader` (and cleared here
 * once sent).
 */
internal class SyncWriter(private val db: LionReaderDatabase) {
    private val store = LocalStore(db)

    val cursors: SyncCursors?
        get() = store.cursors

    val bootstrapCursors: SyncCursors?
        get() = store.bootstrapCursors

    val catchUpStart: SyncCursors?
        get() = store.catchUpStart

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

    val collectionsListed: Boolean
        get() = store.collectionsListed

    /**
     * Saves a page of a collection's articles, with their membership in it. The [first] page
     * replaces what the device had for the collection.
     */
    fun saveCollectionPage(collectionId: String, items: List<EntryListItem>, first: Boolean) =
        db.transaction {
            if (first) db.collectionEntryQueries.deleteForSubscription(collectionId)
            for (item in items) {
                store.upsertEntry(item)
                db.collectionEntryQueries.insertIgnore(collectionId, item.id)
            }
        }

    fun finishCollections() = db.transaction { store.collectionsListed = true }

    var recentlyReadSeen: Long?
        get() = store.recentlyReadSeen
        set(value) {
            store.recentlyReadSeen = value
        }

    /**
     * Saves a page of the server's Recently Read, like any list page, keeping only entries read
     * since [windowStart] (retention would drop the rest).
     */
    fun saveRecentlyRead(items: List<EntryListItem>, windowStart: Long) = db.transaction {
        val recent = items.filter { item ->
            item.readChangedAt?.let { parseMillis(it) >= windowStart } == true
        }
        recent.forEach(store::upsertEntry)
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
        // Before the events: an unsubscribe in the same page keeps what's in a collection.
        page.collectionMemberships.forEach { store.setCollections(it.entryId, it.subscriptionIds) }
        page.events.forEach(::apply)
        for (entry in page.fetchedEntries) {
            store.upsertEntry(
                entry.id,
                entry.subscriptionId,
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
                entry.readChangedAt,
            )
            // The fetched body is current: it replaces the old one and wins
            // over any download already in flight.
            db.entryQueries.bumpBodyVersion(entry.id)
        }
        val versions = page.fetchedEntries.associate { it.id to (bodyVersion(it.id) ?: 0L) }
        storeBodiesInTransaction(page.fetchedEntries, texts, emptyList(), versions, now)
        page.resubscribedEntries.forEach(store::upsertEntry)
        store.cursors = page.cursors
        store.catchUpStart = if (page.hasMore) page.catchUpStart else null
    }

    private fun apply(event: SyncEvent) {
        when (event) {
            is SyncEvent.NewEntry -> {
                val entry = event.entry
                val type = event.entryType
                // Without its type, SyncEngine fetches the entry whole instead.
                if (entry != null && type != null) {
                    store.upsertEntry(
                        event.entryId,
                        event.subscriptionId,
                        type,
                        entry.url,
                        entry.title,
                        entry.author,
                        entry.summary,
                        entry.siteName,
                        entry.feedTitle,
                        entry.publishedAt,
                        entry.fetchedAt,
                        entry.read ?: false,
                        entry.starred ?: false,
                        entry.readChangedAt,
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
                    // The body may have changed too: this makes it, and any
                    // download that started before now, out of date, to
                    // download again (it stays until then).
                    db.entryQueries.bumpBodyVersion(event.entryId)
                }
            is SyncEvent.EntryStateChanged -> {
                val entry = event.entry
                val type = event.entryType
                when {
                    store.entryExists(event.entryId) ->
                        db.entryQueries.updateServerState(
                            if (event.read) 1 else 0,
                            if (event.starred) 1 else 0,
                            event.readChangedAt?.let(::parseMillis),
                            event.entryId,
                        )
                    entry != null && type != null ->
                        store.upsertEntry(
                            event.entryId,
                            event.subscriptionId,
                            type,
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
                            event.readChangedAt,
                        )
                }
            }
            is SyncEvent.SubscriptionCreated ->
                with(event) {
                    store.upsertSubscription(
                        subscription.id,
                        subscription.customTitle ?: feed.title,
                        feed.title,
                        feed.url,
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
                        state.readChangedAt?.let(::parseMillis),
                        state.id,
                    )
                }
            }
        }
        batch.forEach {
            db.outboxQueries.deleteStateIfUnchanged(
                it.entry_id,
                it.field_,
                it.value_,
                it.changed_at,
            )
        }
    }

    // ---- Bodies and retention -------------------------------------------

    /**
     * Stores downloaded bodies, and an empty one for each [missing] id (asked for but not returned:
     * no longer visible) so it isn't requested again, each at the [versions] its entry had when the
     * download started ([putBody] says which are kept). Never touches `entry`, which is why it's
     * safe outside the sync lock. Returns how much the stored bodies grew.
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
            stored += putBody(entry.id, content, size, text, version, now)
        }
        missing.forEach { id -> versions[id]?.let { stored += putBody(id, "", 0, "", it, now) } }
        return stored
    }

    /**
     * Stores a body downloaded at [version] in place of an older one, never a newer one (versions
     * only grow), while the entry is on the device; how much that grew the stored bodies. One an
     * edit overtook mid-download is still stored, out of date, rather than leaving the article
     * without a body: the background download replaces it. A summary goes when the body it
     * summarized is replaced by a different one.
     */
    private fun putBody(
        entryId: String,
        content: String,
        size: Long,
        searchText: String,
        version: Long,
        now: Long,
    ): Long {
        if (bodyVersion(entryId) == null) return 0
        val stored = db.bodyQueries.stored(entryId).executeAsOneOrNull()
        if (stored != null && stored.body_version >= version) return 0
        if (db.bodyQueries.matches(entryId, content).executeAsOne() == 0L) {
            db.summaryQueries.deleteOutdated(entryId, version)
        }
        db.bodyQueries.put(entryId, content, size, now, searchText, version)
        return size - (stored?.size ?: 0)
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

    /** Entries whose body an edit made out of date, with the body version to download them at. */
    fun outdatedBodies(limit: Long): Map<String, Long> =
        db.entryQueries.selectOutdatedBodies(limit).executeAsList().associate {
            it.id to it.body_version
        }

    fun hasBody(entryId: String): Boolean = db.bodyQueries.exists(entryId).executeAsOne() > 0

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

    /** Keeps a summary the user asked for, if its entry is still at [bodyVersion]. */
    fun storeSummary(entryId: String, html: String, bodyVersion: Long) =
        db.summaryQueries.putIfCurrent(entryId, html, bodyVersion)
}

private const val RECENTLY_OPENED_MILLIS = 24L * 60 * 60 * 1000
