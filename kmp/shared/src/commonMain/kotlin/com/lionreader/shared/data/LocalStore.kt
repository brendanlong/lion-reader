package com.lionreader.shared.data

import com.lionreader.shared.api.ApiJson
import com.lionreader.shared.api.EntryListItem
import com.lionreader.shared.api.Subscription
import com.lionreader.shared.api.SyncCursors
import com.lionreader.shared.api.Tag
import com.lionreader.shared.api.TagRef
import com.lionreader.shared.db.LionReaderDatabase

private const val CURSORS_KEY = "sync_cursors"
private const val BOOTSTRAP_CURSORS_KEY = "bootstrap_cursors"
private const val CATCH_UP_START_KEY = "catch_up_start"
private const val RECENTLY_READ_KEY = "recently_read_seen"
private const val COLLECTIONS_LISTED_KEY = "collections_listed"

/** Row-level writes shared by [com.lionreader.shared.sync.SyncWriter]; no transactions here. */
internal class LocalStore(val db: LionReaderDatabase) {
    private val entries = db.entryQueries
    private val subs = db.subscriptionQueries
    private val meta = db.appMetadataQueries

    var cursors: SyncCursors?
        get() = readCursors(CURSORS_KEY)
        set(value) = writeCursors(CURSORS_KEY, value)

    /** Start cursors of a bootstrap still in progress. */
    var bootstrapCursors: SyncCursors?
        get() = readCursors(BOOTSTRAP_CURSORS_KEY)
        set(value) = writeCursors(BOOTSTRAP_CURSORS_KEY, value)

    /**
     * The newest read time in the server's Recently Read when the device last fetched it (see
     * SyncEngine.refreshRecentlyRead); null before the first fetch.
     */
    var recentlyReadSeen: Long?
        get() = meta.selectValue(RECENTLY_READ_KEY).executeAsOneOrNull()?.toLong()
        set(value) {
            if (value != null) meta.upsert(RECENTLY_READ_KEY, "$value")
            else meta.delete(RECENTLY_READ_KEY)
        }

    /** Whether every collection's articles have been listed since the database was cleared. */
    var collectionsListed: Boolean
        get() = meta.selectValue(COLLECTIONS_LISTED_KEY).executeAsOneOrNull() != null
        set(value) {
            if (value) meta.upsert(COLLECTIONS_LISTED_KEY, "1")
            else meta.delete(COLLECTIONS_LISTED_KEY)
        }

    /** The cursors a catch-up still in progress (more pages follow) started from. */
    var catchUpStart: SyncCursors?
        get() = readCursors(CATCH_UP_START_KEY)
        set(value) = writeCursors(CATCH_UP_START_KEY, value)

    private fun readCursors(key: String): SyncCursors? =
        meta.selectValue(key).executeAsOneOrNull()?.let {
            ApiJson.decodeFromString(SyncCursors.serializer(), it)
        }

    private fun writeCursors(key: String, value: SyncCursors?) {
        if (value == null) {
            meta.delete(key)
        } else {
            meta.upsert(key, ApiJson.encodeToString(SyncCursors.serializer(), value))
        }
    }

    fun upsertEntry(
        id: String,
        subscriptionId: String?,
        type: String,
        url: String?,
        title: String?,
        author: String?,
        summary: String?,
        siteName: String?,
        feedTitle: String?,
        publishedAt: String?,
        fetchedAt: String,
        read: Boolean,
        starred: Boolean,
        /**
         * Null if read state never changed (the server never clears it, so a stored time stays).
         */
        readChangedAt: String?,
    ) {
        val published = publishedAt?.let(::parseMillis)
        val fetched = parseMillis(fetchedAt)
        entries.insertIgnore(
            id,
            type,
            fetched,
            published ?: fetched,
            read.toLong(),
            starred.toLong(),
        )
        entries.updateAll(
            subscription_id = subscriptionId,
            type = type,
            url = url,
            title = title,
            author = author,
            summary = summary,
            site_name = siteName,
            feed_title = feedTitle,
            published_at = published,
            fetched_at = fetched,
            sort_at = published ?: fetched,
            read = read.toLong(),
            starred = starred.toLong(),
            `value` = readChangedAt?.let(::parseMillis),
            id = id,
        )
    }

    fun upsertEntry(item: EntryListItem) =
        upsertEntry(
            item.id,
            item.subscriptionId,
            item.type,
            item.url,
            item.title,
            item.author,
            item.summary,
            item.siteName,
            item.feedTitle,
            item.publishedAt,
            item.fetchedAt,
            item.read,
            item.starred,
            item.readChangedAt,
        )

    fun entryExists(id: String): Boolean = entries.exists(id).executeAsOne() > 0

    fun deleteEntry(id: String) {
        entries.deleteById(id)
        db.collectionEntryQueries.deleteForEntry(id)
        db.bodyQueries.deleteForEntry(id)
        db.summaryQueries.deleteForEntry(id)
        db.outboxQueries.deleteStatesForEntry(id)
    }

    fun upsertSubscription(
        id: String,
        title: String?,
        originalTitle: String?,
        url: String?,
        tags: List<TagRef>,
    ) {
        subs.upsertSubscription(id, title, url, originalTitle)
        setSubscriptionTags(id, tags)
    }

    fun upsertSubscription(subscription: Subscription) =
        upsertSubscription(
            subscription.id,
            subscription.title,
            subscription.originalTitle,
            subscription.url,
            subscription.tags,
        )

    fun setSubscriptionTags(subscriptionId: String, tags: List<TagRef>) {
        subs.clearSubscriptionTags(subscriptionId)
        for (tag in tags) {
            upsertTag(tag)
            subs.addSubscriptionTag(subscriptionId, tag.id)
        }
    }

    fun deleteSubscription(id: String) {
        subs.deleteSubscription(id)
        subs.clearSubscriptionTags(id)
        // A deleted collection's members that it alone kept visible arrive as
        // deletions (the server moves their state when it empties it).
        db.collectionEntryQueries.deleteForSubscription(id)
        entries.deleteUnstarredForSubscription(id)
        db.bodyQueries.pruneOrphans()
        db.summaryQueries.pruneOrphans()
    }

    fun setCollections(entryId: String, subscriptionIds: List<String>) {
        db.collectionEntryQueries.deleteForEntry(entryId)
        subscriptionIds.forEach { db.collectionEntryQueries.insertIgnore(it, entryId) }
    }

    fun upsertTag(tag: TagRef) {
        subs.insertTagIgnore(tag.id, tag.name, tag.color)
        subs.updateTag(tag.name, tag.color, tag.id)
    }

    fun upsertTag(tag: Tag) = upsertTag(TagRef(tag.id, tag.name, tag.color))

    fun deleteTag(id: String) {
        subs.deleteTag(id)
        subs.deleteTagLinks(id)
    }

    /** Forgets everything synced, keeping unsent changes (a resync). */
    fun clearSynced() {
        entries.deleteAll()
        db.bodyQueries.deleteAll()
        db.summaryQueries.deleteAll()
        subs.deleteAllSubscriptions()
        subs.deleteAllTags()
        subs.deleteAllSubscriptionTags()
        db.collectionEntryQueries.deleteAll()
        meta.deleteAll()
    }
}

internal fun Boolean.toLong(): Long = if (this) 1L else 0L
