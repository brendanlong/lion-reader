package com.lionreader.shared.data

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import app.cash.sqldelight.coroutines.mapToOneOrNull
import com.lionreader.shared.db.LionReaderDatabase
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext

/** Which list the user is looking at. */
sealed interface ListScope {
    data object All : ListScope

    data object Starred : ListScope

    data object Saved : ListScope

    data class Subscription(val id: String) : ListScope

    data class Tag(val id: String) : ListScope
}

data class TimelineItem(
    val id: String,
    val title: String?,
    val summary: String?,
    val source: String?,
    val author: String?,
    val url: String?,
    val sortAtMillis: Long,
    val read: Boolean,
    val starred: Boolean,
)

data class EntryDetail(
    val id: String,
    val title: String?,
    val author: String?,
    val source: String?,
    val url: String?,
    val sortAtMillis: Long,
    val read: Boolean,
    val starred: Boolean,
    /** Sanitized HTML (the server sanitizes on every read); null until downloaded. */
    val content: String?,
)

data class NavSubscription(
    val id: String,
    val title: String,
    val unread: Int,
    val tagIds: List<String>,
)

data class NavTag(val id: String, val name: String, val color: String?, val unread: Int)

data class Navigation(
    val allUnread: Int,
    val starredUnread: Int,
    val savedUnread: Int,
    val tags: List<NavTag>,
    val subscriptions: List<NavSubscription>,
) {
    val uncategorized: List<NavSubscription>
        get() = subscriptions.filter { it.tagIds.isEmpty() }

    fun subscriptionsIn(tagId: String): List<NavSubscription> = subscriptions.filter {
        tagId in it.tagIds
    }
}

/**
 * The UI's view of the offline store: lists, entries, and unread counts, all reflecting unsent
 * changes, plus the user's actions (recorded in the outbox; [onLocalChange] should schedule a
 * flush).
 */
class Reader(
    private val db: LionReaderDatabase,
    private val now: () -> Long,
    private val context: CoroutineContext,
    private val onLocalChange: () -> Unit,
) {
    /**
     * One list, newest first. With [unreadOnly], entries in [keepIds] stay even once read, so an
     * entry the user just read or swiped doesn't vanish from under them (the web keeps list
     * membership until the list is reloaded).
     */
    fun timeline(
        scope: ListScope,
        unreadOnly: Boolean,
        keepIds: Collection<String>,
        limit: Long,
    ): Flow<List<TimelineItem>> =
        db.entryQueries
            .selectTimeline(
                subscriptionId = (scope as? ListScope.Subscription)?.id,
                tagId = (scope as? ListScope.Tag)?.id,
                starredOnly = if (scope == ListScope.Starred) 1L else 0L,
                savedOnly = if (scope == ListScope.Saved) 1L else 0L,
                unreadOnly = if (unreadOnly) 1L else 0L,
                keepIds = keepIds,
                limit = limit,
            ) { id, _, _, url, title, author, summary, siteName, feedTitle, sortAt, read, starred ->
                TimelineItem(
                    id = id,
                    title = title,
                    summary = summary,
                    source = feedTitle ?: siteName,
                    author = author,
                    url = url,
                    sortAtMillis = sortAt,
                    read = read == 1L,
                    starred = starred == 1L,
                )
            }
            .asFlow()
            .mapToList(context)

    fun entry(id: String): Flow<EntryDetail?> =
        db.entryQueries.selectById(id).asFlow().mapToOneOrNull(context).map { row ->
            row?.let {
                EntryDetail(
                    id = it.id,
                    title = it.title,
                    author = it.author,
                    source = it.feed_title ?: it.site_name,
                    url = it.url,
                    sortAtMillis = it.sort_at,
                    read = it.effective_read == 1L,
                    starred = it.effective_starred == 1L,
                    content = it.content,
                )
            }
        }

    /** Unread counts are the server's, corrected for changes not yet sent. */
    fun navigation(): Flow<Navigation> {
        val subs = db.subscriptionQueries
        return combine(
            subs.selectSubscriptions().asFlow().mapToList(context),
            subs.selectTags().asFlow().mapToList(context),
            subs.selectSubscriptionTags().asFlow().mapToList(context),
            subs.selectListCounts().asFlow().mapToList(context),
            db.outboxQueries.pendingEntryStates().asFlow().mapToList(context),
        ) { subscriptions, tags, links, listCounts, pending ->
            val tagsBySub = links.groupBy({ it.subscription_id }, { it.tag_id })
            val lists = listCounts.associate { it.list to it.unread.toInt() }.toMutableMap()
            val subDelta = mutableMapOf<String, Int>()
            val tagDelta = mutableMapOf<String, Int>()
            // Each unsent change moves an entry's contribution from its
            // server state (which the server's counts reflect) to its
            // effective state.
            for (entry in pending) {
                val unreadBefore = entry.read == 0L
                val unreadAfter = entry.effective_read == 0L
                val delta = unreadAfter.toInt() - unreadBefore.toInt()
                val starredDelta =
                    (entry.effective_starred == 1L && unreadAfter).toInt() -
                        (entry.starred == 1L && unreadBefore).toInt()
                if (starredDelta != 0) lists.merge("starred", starredDelta, Int::plus)
                if (delta == 0) continue
                lists.merge("all", delta, Int::plus)
                if (entry.type == "saved") lists.merge("saved", delta, Int::plus)
                entry.subscription_id?.let { sub ->
                    subDelta.merge(sub, delta, Int::plus)
                    tagsBySub[sub].orEmpty().forEach { tagDelta.merge(it, delta, Int::plus) }
                }
            }
            Navigation(
                allUnread = lists["all"].nonNegative(),
                starredUnread = lists["starred"].nonNegative(),
                savedUnread = lists["saved"].nonNegative(),
                tags =
                    tags.map {
                        NavTag(
                            it.id,
                            it.name,
                            it.color,
                            (it.unread_count.toInt() + (tagDelta[it.id] ?: 0)).coerceAtLeast(0),
                        )
                    },
                subscriptions =
                    subscriptions.map {
                        NavSubscription(
                            id = it.id,
                            title = it.title ?: it.url ?: "Untitled",
                            unread =
                                (it.unread_count.toInt() + (subDelta[it.id] ?: 0)).coerceAtLeast(0),
                            tagIds = tagsBySub[it.id].orEmpty(),
                        )
                    },
            )
        }
    }

    suspend fun setRead(ids: Collection<String>, read: Boolean) {
        withContext(context) {
            val time = now()
            db.transaction {
                ids.forEach { db.outboxQueries.putState(it, "read", read.toLong(), time) }
            }
        }
        onLocalChange()
    }

    suspend fun setStarred(id: String, starred: Boolean) {
        withContext(context) { db.outboxQueries.putState(id, "starred", starred.toLong(), now()) }
        onLocalChange()
    }

    suspend fun markOpened(id: String) =
        withContext(context) { db.entryQueries.markOpened(now(), id) }

    /**
     * Marks everything in [scope] read: locally for the entries on the device, and on the server
     * (when sent) for everything up to the newest entry the device had seen, so nothing that
     * arrives later is swept up.
     */
    suspend fun markAllRead(scope: ListScope) {
        withContext(context) {
            val time = now()
            db.transaction {
                val before =
                    db.entryQueries.newestFetchedAt().executeAsOneOrNull()?.MAX
                        ?: return@transaction
                val subscriptionId = (scope as? ListScope.Subscription)?.id
                val tagId = (scope as? ListScope.Tag)?.id
                val starredOnly = if (scope == ListScope.Starred) 1L else 0L
                val savedOnly = if (scope == ListScope.Saved) 1L else 0L
                db.entryQueries
                    .unreadIdsInScope(subscriptionId, tagId, starredOnly, savedOnly, before)
                    .executeAsList()
                    .forEach { db.outboxQueries.putState(it, "read", 1L, time) }
                db.outboxQueries.addMarkAll(
                    subscriptionId,
                    tagId,
                    starredOnly,
                    savedOnly,
                    before,
                    time,
                )
            }
        }
        onLocalChange()
    }
}

private fun Boolean.toInt(): Int = if (this) 1 else 0

private fun Int?.nonNegative(): Int = (this ?: 0).coerceAtLeast(0)
