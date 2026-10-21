package com.lionreader.shared.home

import com.lionreader.shared.data.ListScope
import com.lionreader.shared.data.ListSort

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
    /**
     * The order the user chose for this list on screen; null for its default (`shownSort`). Never
     * kept past it: choosing the list again starts from its default.
     */
    val sort: ListSort? = null,
) {
    /** A list starts at its first page, in its default order, keeping nothing. */
    fun select(scope: ListScope): ListState = ListState(scope)

    fun sortBy(sort: ListSort): ListState = copy(sort = sort)

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
