package com.lionreader.shared.data

import com.lionreader.shared.api.ApiJson
import com.lionreader.shared.api.EntryListItem
import com.lionreader.shared.api.SAVED_TYPE
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
private const val SAVED_SERVER_ID_KEY = "saved_subscription_id"

/**
 * The id the device keeps the user's Saved subscription under (in `subscription_entry`, and
 * `kept_entry` names it), whatever its server id: memberships synced before that id was known (from
 * a server that predates it, or saved before this app version) are Saved too.
 */
internal const val SAVED_SUBSCRIPTION_ID = "saved"

/** Row-level writes shared by [com.lionreader.shared.sync.SyncWriter]; no transactions here. */
internal class LocalStore(val db: LionReaderDatabase) {
    private val entries = db.entryQueries
    private val subs = db.subscriptionQueries
    private val meta = db.appMetadataQueries
    private val memberships = db.subscriptionEntryQueries

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

    /** The server's id for the Saved subscription, once known ([learnSavedSubscription]). */
    val savedServerId: String?
        get() = meta.selectValue(SAVED_SERVER_ID_KEY).executeAsOneOrNull()

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
        /** The entry's memberships; null from a server that predates them. */
        subscriptionIds: List<String>?,
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
        if (subscriptionIds != null) {
            setMemberships(id, subscriptionIds)
        } else {
            // A server older than subscriptionIds (#1846): what this one says is added to what
            // the device knew, as the server had it then (its type was what made it saved).
            subscriptionId?.let { memberships.insertIgnore(localSubscriptionId(it), id) }
            if (type == SAVED_TYPE) memberships.insertIgnore(SAVED_SUBSCRIPTION_ID, id)
        }
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
            item.subscriptionIds,
        )

    fun entryExists(id: String): Boolean = entries.exists(id).executeAsOne() > 0

    fun deleteEntry(id: String) {
        entries.deleteById(id)
        memberships.deleteForEntry(id)
        db.bodyQueries.deleteForEntry(id)
        db.summaryQueries.deleteForEntry(id)
        db.outboxQueries.deleteStatesForEntry(id)
    }

    /** Saved is never stored as a subscription: it's a list of its own, in no tag. */
    fun upsertSubscription(
        id: String,
        title: String?,
        originalTitle: String?,
        url: String?,
        type: String?,
        tags: List<TagRef>,
    ) {
        if (type == SAVED_TYPE) learnSavedSubscription(id)
        if (localSubscriptionId(id) == SAVED_SUBSCRIPTION_ID) return
        subs.upsertSubscription(id, title, url, originalTitle, type)
        setSubscriptionTags(id, tags)
    }

    fun upsertSubscription(subscription: Subscription) =
        upsertSubscription(
            subscription.id,
            subscription.title,
            subscription.originalTitle,
            subscription.url,
            subscription.type,
            subscription.tags,
        )

    /** A subscription's new custom title (null: none) and tags. */
    fun updateSubscription(id: String, customTitle: String?, tags: List<TagRef>) {
        if (localSubscriptionId(id) == SAVED_SUBSCRIPTION_ID) return
        subs.updateSubscriptionTitle(customTitle, id)
        setSubscriptionTags(id, tags)
    }

    private fun setSubscriptionTags(subscriptionId: String, tags: List<TagRef>) {
        subs.clearSubscriptionTags(subscriptionId)
        for (tag in tags) {
            upsertTag(tag)
            subs.addSubscriptionTag(subscriptionId, tag.id)
        }
    }

    fun deleteSubscription(serverId: String) {
        val id = localSubscriptionId(serverId)
        subs.deleteSubscription(id)
        subs.clearSubscriptionTags(id)
        entries.deleteUnstarredOnlyIn(id)
        memberships.deleteForSubscription(id)
        memberships.pruneOrphans()
        db.bodyQueries.pruneOrphans()
        db.summaryQueries.pruneOrphans()
    }

    /** Replaces an entry's memberships with the server's [subscriptionIds]. */
    fun setMemberships(entryId: String, subscriptionIds: List<String>) {
        val savedId = savedServerId
        memberships.deleteForEntry(entryId)
        for (id in subscriptionIds) {
            memberships.insertIgnore(if (id == savedId) SAVED_SUBSCRIPTION_ID else id, entryId)
        }
    }

    /**
     * Replaces an entry's collections with [collectionIds], from a server that sends an entry's
     * collections but not its `subscriptionIds`: its feed and Saved stay as they were.
     */
    fun setCollections(entryId: String, collectionIds: List<String>) {
        val kept = buildList {
            entries.selectOrigin(entryId).executeAsOneOrNull()?.subscription_id?.let {
                add(localSubscriptionId(it))
            }
            if (memberships.contains(SAVED_SUBSCRIPTION_ID, entryId).executeAsOne() > 0) {
                add(SAVED_SUBSCRIPTION_ID)
            }
        }
        memberships.deleteForEntry(entryId)
        (kept + collectionIds).forEach { memberships.insertIgnore(it, entryId) }
    }

    /**
     * Records the Saved subscription's server id, moving memberships stored under it (before it was
     * known) to [SAVED_SUBSCRIPTION_ID].
     */
    fun learnSavedSubscription(serverId: String) {
        if (serverId == savedServerId) return
        meta.upsert(SAVED_SERVER_ID_KEY, serverId)
        memberships.moveSubscription(to = SAVED_SUBSCRIPTION_ID, from = serverId)
        subs.deleteSubscription(serverId)
        subs.clearSubscriptionTags(serverId)
    }

    private fun localSubscriptionId(serverId: String): String =
        if (serverId == savedServerId) SAVED_SUBSCRIPTION_ID else serverId

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
        memberships.deleteAll()
        meta.deleteAll()
    }
}

internal fun Boolean.toLong(): Long = if (this) 1L else 0L
