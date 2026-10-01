package com.lionreader.shared.data

import app.cash.sqldelight.coroutines.asFlow
import app.cash.sqldelight.coroutines.mapToList
import app.cash.sqldelight.coroutines.mapToOne
import app.cash.sqldelight.coroutines.mapToOneOrNull
import com.lionreader.shared.db.LionReaderDatabase
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.withContext

/** Which list the user is looking at. */
sealed interface ListScope {
    data object All : ListScope

    data object Starred : ListScope

    data object Saved : ListScope

    data class Subscription(val id: String) : ListScope

    data class Tag(val id: String) : ListScope

    /** Feeds without a tag. */
    data object Uncategorized : ListScope

    /** Entries whose read state changed, latest first, as the web's Recently Read. */
    data object RecentlyRead : ListScope
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
    /** The AI summary, sanitized HTML; null until the user asks for one. */
    val summary: String?,
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
     * One list, newest first. Entries in [keepIds] stay even once read (with [unreadOnly]) or
     * unstarred (in Starred), so an entry the user just read or swiped doesn't vanish from under
     * them (the web keeps list membership until the list is reloaded).
     */
    fun timeline(
        scope: ListScope,
        unreadOnly: Boolean,
        keepIds: Collection<String>,
        limit: Long,
    ): Flow<List<TimelineItem>> {
        // Read and unread alike: it's the list of what was read.
        if (scope == ListScope.RecentlyRead) {
            return db.entryQueries
                .selectRecentlyRead(limit, ::timelineItem)
                .asFlow()
                .mapToList(context)
        }
        return db.entryQueries
            .selectTimeline(
                subscriptionId = (scope as? ListScope.Subscription)?.id,
                tagId = (scope as? ListScope.Tag)?.id,
                starredOnly = if (scope == ListScope.Starred) 1L else 0L,
                savedOnly = if (scope == ListScope.Saved) 1L else 0L,
                uncategorizedOnly = if (scope == ListScope.Uncategorized) 1L else 0L,
                unreadOnly = if (unreadOnly) 1L else 0L,
                keepIds = keepIds,
                limit = limit,
                mapper = ::timelineItem,
            )
            .asFlow()
            .mapToList(context)
    }

    @Suppress("UNUSED_PARAMETER")
    private fun timelineItem(
        id: String,
        subscriptionId: String?,
        type: String,
        url: String?,
        title: String?,
        author: String?,
        summary: String?,
        siteName: String?,
        feedTitle: String?,
        sortAt: Long,
        read: Long,
        starred: Long,
    ) =
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
                    summary = it.ai_summary,
                )
            }
        }

    /**
     * Articles on the device matching what the user typed (see [searchQuery]), newest first:
     * titles, authors, feeds, summaries and downloaded bodies.
     */
    fun search(text: String, limit: Long): Flow<List<TimelineItem>> {
        val query = searchQuery(text) ?: return flowOf(emptyList())
        return db.searchQueries
            .search(query, limit) {
                id,
                url,
                title,
                author,
                summary,
                siteName,
                feedTitle,
                sortAt,
                read,
                starred ->
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
    }

    /** Lists and their unread counts, counted on the device (see kmp/CLAUDE.md). */
    fun navigation(): Flow<Navigation> {
        val subs = db.subscriptionQueries
        val entries = db.entryQueries
        return combine(
            subs.selectSubscriptions().asFlow().mapToList(context),
            subs.selectTags().asFlow().mapToList(context),
            subs.selectSubscriptionTags().asFlow().mapToList(context),
            entries.unreadTotals().asFlow().mapToOne(context),
            combine(
                entries.unreadBySubscription().asFlow().mapToList(context),
                entries.unreadByTag().asFlow().mapToList(context),
                ::Pair,
            ),
        ) { subscriptions, tags, links, totals, (bySubscription, byTag) ->
            val tagsBySub = links.groupBy({ it.subscription_id }, { it.tag_id })
            val subUnread = bySubscription.associate { it.subscription_id to it.unread.toInt() }
            val tagUnread = byTag.associate { it.tag_id to it.unread.toInt() }
            Navigation(
                allUnread = totals.all_unread.toInt(),
                starredUnread = totals.starred_unread.toInt(),
                savedUnread = totals.saved_unread.toInt(),
                tags = tags.map { NavTag(it.id, it.name, it.color, tagUnread[it.id] ?: 0) },
                subscriptions =
                    subscriptions.map {
                        NavSubscription(
                            id = it.id,
                            title = it.title ?: it.url ?: "Untitled",
                            unread = subUnread[it.id] ?: 0,
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
     * The unread entries of [scope] on the device: what mark-all-read marks (with [setRead]). Taken
     * when the user is asked to confirm, so entries a sync adds meanwhile aren't marked unseen.
     */
    suspend fun unreadIds(scope: ListScope): List<String> =
        withContext(context) { queryUnreadIds(scope) }

    private fun queryUnreadIds(scope: ListScope): List<String> =
        db.entryQueries
            .unreadIdsInScope(
                subscriptionId = (scope as? ListScope.Subscription)?.id,
                tagId = (scope as? ListScope.Tag)?.id,
                starredOnly = if (scope == ListScope.Starred) 1L else 0L,
                savedOnly = if (scope == ListScope.Saved) 1L else 0L,
                uncategorizedOnly = if (scope == ListScope.Uncategorized) 1L else 0L,
                recentlyReadOnly = if (scope == ListScope.RecentlyRead) 1L else 0L,
            )
            .executeAsList()
}
