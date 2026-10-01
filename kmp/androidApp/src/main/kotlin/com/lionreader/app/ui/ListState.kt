package com.lionreader.app.ui

import com.lionreader.shared.data.ListScope

/**
 * Which list is on screen and how much of it. One value, changed by the functions below, so a
 * change is one step: the query never sees a new list with the old one's kept entries.
 */
internal data class ListState(
    val scope: ListScope = ListScope.All,
    /**
     * Entries touched since the list was chosen, kept in an unread-only list once read and in
     * Starred once unstarred, until the list is chosen again or refreshed. Bounded: the ids are
     * bound into one query (SQLite allows 999 variables).
     */
    val keepIds: Set<String> = emptySet(),
    val limit: Long = PAGE,
) {
    /** A list starts at its first page, keeping nothing. */
    fun select(scope: ListScope): ListState = ListState(scope)

    fun loadMore(): ListState = copy(limit = limit + PAGE)

    /** The most recently touched [MAX_KEPT] are kept. */
    fun keep(id: String): ListState =
        copy(keepIds = (keepIds - id + id).toList().takeLast(MAX_KEPT).toSet())

    /** Read entries leave an unread-only list, but [except] (the article open beside it). */
    fun letGoOfKept(except: String? = null): ListState = copy(keepIds = setOfNotNull(except))

    companion object {
        const val PAGE = 200L
        private const val MAX_KEPT = 200
    }
}
