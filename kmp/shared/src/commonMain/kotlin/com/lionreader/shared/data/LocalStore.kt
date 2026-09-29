package com.lionreader.shared.data

import com.lionreader.shared.api.EntryListItem
import com.lionreader.shared.api.FeedType
import com.lionreader.shared.api.FullEntry
import com.lionreader.shared.api.Subscription
import com.lionreader.shared.api.SyncCursors
import com.lionreader.shared.api.Tag
import com.lionreader.shared.api.TagRef
import com.lionreader.shared.api.UnreadCounts
import com.lionreader.shared.db.LionReaderDatabase

private const val CURSORS_KEY = "sync_cursors"

internal fun FeedType.wire(): String =
    when (this) {
        FeedType.WEB -> "web"
        FeedType.EMAIL -> "email"
        FeedType.SAVED -> "saved"
    }

/** Server data → local tables. Callers group calls in a transaction. */
internal class LocalStore(val db: LionReaderDatabase) {
    private val entries = db.entryQueries
    private val subs = db.subscriptionQueries
    private val meta = db.appMetadataQueries

    var cursors: SyncCursors?
        get() =
            meta.selectValue(CURSORS_KEY).executeAsOneOrNull()?.let {
                com.lionreader.shared.api.ApiJson.decodeFromString(SyncCursors.serializer(), it)
            }
        set(value) {
            if (value == null) {
                meta.delete(CURSORS_KEY)
            } else {
                meta.upsert(
                    CURSORS_KEY,
                    com.lionreader.shared.api.ApiJson.encodeToString(
                        SyncCursors.serializer(),
                        value,
                    ),
                )
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

    fun upsertEntry(entry: FullEntry, now: Long) {
        upsertEntry(
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
        entries.setContent(entry.displayContent ?: "", now, entry.id)
    }

    fun entryExists(id: String): Boolean = entries.exists(id).executeAsOne() > 0

    fun deleteEntry(id: String) {
        entries.deleteById(id)
        db.outboxQueries.deleteStatesForEntry(id)
    }

    fun upsertSubscription(
        id: String,
        feedId: String?,
        type: FeedType,
        title: String?,
        url: String?,
        siteUrl: String?,
        unread: Int,
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
            unread.toLong(),
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
            subscription.unreadCount,
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
    }

    fun upsertTag(tag: TagRef) {
        subs.insertTagIgnore(tag.id, tag.name, tag.color)
        subs.updateTag(tag.name, tag.color, tag.id)
    }

    fun upsertTag(tag: Tag) {
        upsertTag(TagRef(tag.id, tag.name, tag.color))
        subs.setTagUnread(tag.unreadCount.toLong(), tag.id)
    }

    fun deleteTag(id: String) {
        subs.deleteTag(id)
        subs.deleteTagLinks(id)
    }

    fun applyCounts(counts: UnreadCounts) {
        subs.setListCount("all", counts.all.unread.toLong())
        subs.setListCount("starred", counts.starred.unread.toLong())
        counts.saved?.let { subs.setListCount("saved", it.unread.toLong()) }
        counts.uncategorized?.let { subs.setListCount("uncategorized", it.unread.toLong()) }
        counts.subscriptions.forEach { subs.setSubscriptionUnread(it.unread.toLong(), it.id) }
        counts.tags.forEach { subs.setTagUnread(it.unread.toLong(), it.id) }
    }

    fun setListCount(list: String, unread: Int) = subs.setListCount(list, unread.toLong())

    /** Forgets everything synced, keeping unsent changes (a resync). */
    fun clearSynced() {
        entries.deleteAll()
        subs.deleteAllSubscriptions()
        subs.deleteAllTags()
        subs.deleteAllSubscriptionTags()
        subs.deleteAllListCounts()
        meta.deleteAll()
    }

    /** Forgets everything, unsent changes included (sign-out). */
    fun clearAll() {
        clearSynced()
        db.outboxQueries.deleteAllStates()
        db.outboxQueries.deleteAllMarkAll()
    }
}

internal fun Boolean.toLong(): Long = if (this) 1L else 0L
