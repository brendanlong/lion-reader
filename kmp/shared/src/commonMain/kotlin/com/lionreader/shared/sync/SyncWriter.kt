package com.lionreader.shared.sync

import app.cash.sqldelight.db.SqlDriver
import com.lionreader.shared.api.BulkStateResponse
import com.lionreader.shared.api.EntryListItem
import com.lionreader.shared.api.FullEntry
import com.lionreader.shared.api.SubscriptionPage
import com.lionreader.shared.api.SyncCursors
import com.lionreader.shared.api.SyncEvent
import com.lionreader.shared.api.TagList
import com.lionreader.shared.data.LocalStore
import com.lionreader.shared.data.indexBody
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
 * Table ownership: `entry` state and metadata, memberships, subscriptions, tags and cursors are
 * written here under the sync lock; bodies only by [storeBodies] and summaries only by
 * [storeSummary] and, when the body they summarized is replaced, [storeBodies] (outside the lock,
 * version-guarded, and deleted here with their entry); the outbox by `Reader` (and cleared here
 * once sent).
 */
internal class SyncWriter(private val driver: SqlDriver) {
    private val db = LionReaderDatabase(driver)
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

    fun saveSubscriptions(page: SubscriptionPage) = db.transaction {
        page.items.forEach(store::upsertSubscription)
        db.entryQueries.refreshFeedTitles()
    }

    /** Whether the device doesn't know the Saved subscription's server id yet. */
    val savedSubscriptionUnknown: Boolean
        get() = store.savedServerId == null

    /** The ids of the subscriptions on the device. */
    fun subscriptionIds(): Set<String> =
        db.subscriptionQueries.selectSubscriptions().executeAsList().map { it.id }.toSet()

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
            if (first) db.subscriptionEntryQueries.deleteForSubscription(collectionId)
            for (item in items) {
                store.upsertEntry(item)
                db.subscriptionEntryQueries.insertIgnore(collectionId, item.id)
            }
        }

    fun finishCollections() = db.transaction { store.collectionsListed = true }

    val scoresListed: Boolean
        get() = store.scoresListed

    /** Saves the scores of a page of scored entries, for those on the device. */
    fun saveScores(items: List<EntryListItem>) = db.transaction {
        for (item in items) item.rankings?.let { db.entryQueries.updateScore(it.score, item.id) }
    }

    fun finishScores() = db.transaction { store.scoresListed = true }

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
        // Its entries came with their scores.
        store.scoresListed = true
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
        // Memberships before the events, as the server has them now: an unsubscribe in the same
        // page keeps what's still in another subscription.
        for ((entryId, reported) in page.events.reportedMemberships()) {
            val (ids, positions) = reported
            if (store.entryExists(entryId)) store.setMemberships(entryId, ids, positions)
        }
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
                entry.subscriptionIds,
                entry.rankings,
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
                if (entry != null) {
                    store.upsertEntry(
                        event.entryId,
                        event.subscriptionId,
                        entry.type,
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
                        event.subscriptionIds,
                        // A new entry has none yet; one already here keeps its own.
                        rankings = null,
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
                when {
                    store.entryExists(event.entryId) -> {
                        db.entryQueries.updateServerState(
                            if (event.read) 1 else 0,
                            if (event.starred) 1 else 0,
                            event.readChangedAt?.let(::parseMillis),
                            event.entryId,
                        )
                        // Its memberships again, for their positions: an entry new in this page
                        // (its new_entry, which has none, came first) wasn't here for them.
                        event.rankings?.let {
                            store.setMemberships(event.entryId, event.subscriptionIds, it.positions)
                            db.entryQueries.updateScore(it.score, event.entryId)
                        }
                    }
                    entry != null ->
                        store.upsertEntry(
                            event.entryId,
                            event.subscriptionId,
                            entry.type,
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
                            event.subscriptionIds,
                            event.rankings,
                        )
                }
            }
            is SyncEvent.SubscriptionCreated -> {
                // Without one, SyncEngine listed subscriptions for the page.
                event.subscriptionRow?.let(store::upsertSubscription)
                db.entryQueries.refreshFeedTitlesFor(event.subscriptionId)
            }
            is SyncEvent.SubscriptionUpdated -> {
                val row = event.row
                if (row != null) {
                    store.upsertSubscription(row)
                } else {
                    store.updateSubscription(event.subscriptionId, event.customTitle, event.tags)
                }
                db.entryQueries.refreshFeedTitlesFor(event.subscriptionId)
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
     * safe outside the sync lock. A transaction per body, as nothing ties them together: storing
     * the body of the article the user is waiting on ([SyncEngine.ensureContent]) then waits behind
     * one body's write at most, not a batch's.
     */
    fun storeBodies(
        fetched: List<FullEntry>,
        missing: List<String>,
        versions: Map<String, Long>,
        now: Long,
    ) {
        val texts = searchTexts(fetched)
        for (entry in fetched) {
            db.transaction {
                storeBodiesInTransaction(listOf(entry), texts, emptyList(), versions, now)
            }
        }
        if (missing.isNotEmpty()) {
            db.transaction { storeBodiesInTransaction(emptyList(), texts, missing, versions, now) }
        }
    }

    /** Each body's [searchText], worked out before the write transaction to keep it short. */
    private fun searchTexts(entries: List<FullEntry>): Map<String, String> = entries.associate {
        it.id to searchText(it.content ?: "")
    }

    private fun storeBodiesInTransaction(
        fetched: List<FullEntry>,
        texts: Map<String, String>,
        missing: List<String>,
        versions: Map<String, Long>,
        now: Long,
    ) {
        for (entry in fetched) {
            val version = versions[entry.id] ?: continue
            val content = entry.content ?: ""
            val text = texts.getValue(entry.id)
            // The search index's copy of the text counts against the budget too.
            val size = (content.length + text.length).toLong()
            putBody(entry.id, content, size, text, version, now)
        }
        missing.forEach { id -> versions[id]?.let { putBody(id, "", 0, "", it, now) } }
    }

    /**
     * Stores a body downloaded at [version] in place of an older one, never a newer one (versions
     * only grow), while the entry is on the device. One an edit overtook mid-download is still
     * stored, out of date, rather than leaving the article without a body: the background download
     * replaces it. A summary goes when the body it summarized is replaced by a different one.
     */
    private fun putBody(
        entryId: String,
        content: String,
        size: Long,
        searchText: String,
        version: Long,
        now: Long,
    ) {
        if (bodyVersion(entryId) == null) return
        val stored = db.bodyQueries.stored(entryId).executeAsOneOrNull()
        if (stored != null && stored.body_version >= version) return
        if (db.bodyQueries.matches(entryId, content).executeAsOne() == 0L) {
            db.summaryQueries.deleteOutdated(entryId, version)
        }
        // INSERT OR REPLACE doesn't fire entry_body's delete trigger, so the text replaces the
        // old body's.
        db.bodyQueries.put(entryId, content, size, now, version)
        driver.indexBody(entryId, searchText)
    }

    /** The entry's body version, or null when it isn't on the device. */
    fun bodyVersion(entryId: String): Long? =
        db.entryQueries.bodyVersion(entryId).executeAsOneOrNull()

    /**
     * Entries needing a body that [the budget][trimBodies] has room for, at most [limit], most
     * important first, with the body version to download them at.
     */
    fun missingBodies(limit: Long, budget: Long, now: Long): Map<String, Long> {
        val openedSince = now - RECENTLY_OPENED_MILLIS
        val stored = rankedBodies(openedSince)
        var next = 0
        var above = 0L
        return buildMap {
            for (entry in
                db.entryQueries.selectMissingContent(openedSince, limit).executeAsList()) {
                val rank =
                    BodyRank(
                        entry.kept,
                        entry.opened == 1L,
                        entry.effective_read == 1L,
                        entry.sort_at,
                        entry.id,
                    )
                while (next < stored.size && stored[next].rank < rank) above += stored[next++].size
                if (above >= budget) break
                put(entry.id, entry.body_version)
            }
        }
    }

    /** Entries whose body an edit made out of date, with the body version to download them at. */
    fun outdatedBodies(limit: Long): Map<String, Long> =
        db.entryQueries.selectOutdatedBodies(limit).executeAsList().associate {
            it.id to it.body_version
        }

    fun hasBody(entryId: String): Boolean = db.bodyQueries.exists(entryId).executeAsOne() > 0

    fun evict(policy: RetentionPolicy, now: Long) {
        db.transaction {
            db.entryQueries.evictOutsideWindow(now - policy.windowMillis)
            db.entryQueries.evictBeyondCount(policy.maxReadEntries.toLong())
            db.subscriptionEntryQueries.pruneOrphans()
            db.bodyQueries.pruneOrphans()
            db.summaryQueries.pruneOrphans()
        }
        trimBodies(policy.contentBudgetBytes, now)
    }

    /**
     * Holds the bodies to the content budget. Most important first ([BodyRank]), a body is kept
     * while the ones before it take less than [budget], so the one reaching it stays too; starred,
     * saved and collections' articles' bodies always do. [missingBodies] downloads by the same
     * rule, so what it downloads stays, and an evicted body isn't downloaded again until it would.
     * Ranked before writing, and a transaction per body (see [storeBodies]).
     */
    fun trimBodies(budget: Long, now: Long) {
        var above = 0L
        val evicted =
            rankedBodies(now - RECENTLY_OPENED_MILLIS).filter { body ->
                (above >= budget && !body.rank.kept).also { above += body.size }
            }
        evicted.forEach { db.transaction { db.bodyQueries.deleteForEntry(it.rank.entryId) } }
    }

    private fun rankedBodies(openedSince: Long): List<RankedBody> =
        db.bodyQueries
            .ranked(openedSince)
            .executeAsList()
            .map {
                RankedBody(
                    BodyRank(
                        it.kept,
                        it.opened == 1L,
                        it.effective_read == 1L,
                        it.sort_at,
                        it.entry_id,
                    ),
                    it.size,
                )
            }
            .sortedBy { it.rank }

    /** Keeps a summary the user asked for, if its entry is still at [bodyVersion]. */
    fun storeSummary(entryId: String, html: String, bodyVersion: Long) =
        db.summaryQueries.putIfCurrent(entryId, html, bodyVersion)
}

private const val RECENTLY_OPENED_MILLIS = 24L * 60 * 60 * 1000

/**
 * How much an entry's body matters to the content budget, most first (selectMissingContent sorts
 * the same way): starred, saved and collections' articles' ([kept]); then ones [opened] in the last
 * day, as opening one marks it read and it may still be on screen; unread before read; newest
 * first.
 */
private data class BodyRank(
    val kept: Boolean,
    val opened: Boolean,
    val read: Boolean,
    val sortAt: Long,
    val entryId: String,
) : Comparable<BodyRank> {
    override fun compareTo(other: BodyRank): Int =
        compareValuesBy(
            other,
            this,
            { it.kept },
            { it.opened },
            { !it.read },
            { it.sortAt },
            { it.entryId },
        )
}

private class RankedBody(val rank: BodyRank, val size: Long)

/**
 * Each entry's memberships the events report (the server's, as of the page), with their positions
 * when the event has them.
 */
private fun List<SyncEvent>.reportedMemberships():
    Map<String, Pair<List<String>, Map<String, Double>?>> = buildMap {
    for (event in this@reportedMemberships) {
        when (event) {
            is SyncEvent.NewEntry -> put(event.entryId, event.subscriptionIds to null)
            is SyncEvent.EntryStateChanged ->
                put(event.entryId, event.subscriptionIds to event.rankings?.positions)
            else -> {}
        }
    }
}
