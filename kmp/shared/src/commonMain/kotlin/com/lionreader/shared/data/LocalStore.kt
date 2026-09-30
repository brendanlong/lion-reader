package com.lionreader.shared.data

import com.lionreader.shared.api.ApiJson
import com.lionreader.shared.api.EntryListItem
import com.lionreader.shared.api.FeedType
import com.lionreader.shared.api.Subscription
import com.lionreader.shared.api.SyncCursors
import com.lionreader.shared.api.Tag
import com.lionreader.shared.api.TagRef
import com.lionreader.shared.db.LionReaderDatabase

private const val CURSORS_KEY = "sync_cursors"
private const val BOOTSTRAP_CURSORS_KEY = "bootstrap_cursors"
private const val CATCH_UP_KEY = "catch_up_in_progress"

internal fun FeedType.wire(): String =
    when (this) {
        FeedType.WEB -> "web"
        FeedType.EMAIL -> "email"
        FeedType.SAVED -> "saved"
    }

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

    /** Whether the last pulled page said more pages follow (see SyncEngine.fetchPage). */
    var catchUpInProgress: Boolean
        get() = meta.selectValue(CATCH_UP_KEY).executeAsOneOrNull() == "1"
        set(value) {
            if (value) meta.upsert(CATCH_UP_KEY, "1") else meta.delete(CATCH_UP_KEY)
        }

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
        feedId: String?,
        type: FeedType,
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
    ) {
        val published = publishedAt?.let(::parseMillis)
        val fetched = parseMillis(fetchedAt)
        entries.insertIgnore(
            id,
            feedId,
            type.wire(),
            fetched,
            published ?: fetched,
            read.toLong(),
            starred.toLong(),
        )
        entries.updateAll(
            subscription_id = subscriptionId,
            `value` = feedId,
            type = type.wire(),
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
            id = id,
        )
    }

    fun upsertEntry(item: EntryListItem) =
        upsertEntry(
            item.id,
            item.subscriptionId,
            item.feedId,
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
        )

    fun entryExists(id: String): Boolean = entries.exists(id).executeAsOne() > 0

    fun deleteEntry(id: String) {
        entries.deleteById(id)
        db.bodyQueries.deleteForEntry(id)
        db.outboxQueries.deleteStatesForEntry(id)
    }

    fun upsertSubscription(
        id: String,
        feedId: String?,
        type: FeedType,
        title: String?,
        url: String?,
        siteUrl: String?,
        fetchFullContent: Boolean,
        tags: List<TagRef>,
    ) {
        subs.upsertSubscription(
            id,
            feedId,
            type.wire(),
            title,
            url,
            siteUrl,
            fetchFullContent.toLong(),
        )
        setSubscriptionTags(id, tags)
    }

    fun upsertSubscription(subscription: Subscription) =
        upsertSubscription(
            subscription.id,
            null,
            subscription.type,
            subscription.title,
            subscription.url,
            subscription.siteUrl,
            subscription.fetchFullContent,
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
        entries.deleteUnstarredForSubscription(id)
        db.bodyQueries.pruneOrphans()
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
        subs.deleteAllSubscriptions()
        subs.deleteAllTags()
        subs.deleteAllSubscriptionTags()
        meta.deleteAll()
    }

    /** Forgets everything, unsent changes included (sign-out). */
    fun clearAll() {
        clearSynced()
        db.outboxQueries.deleteAllStates()
    }
}

internal fun Boolean.toLong(): Long = if (this) 1L else 0L
