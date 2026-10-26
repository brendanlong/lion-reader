package com.lionreader.app.ui

import androidx.compose.foundation.pager.PagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.Velocity
import com.lionreader.app.EntryKey

/**
 * Which article each of the article pager's pages shows: the list's [ids], from page [first] on.
 * The pager outlives openings ([EntryScreen]), so an article opens on the page already on screen
 * ([opening]), whose WebView swaps it in, rather than on a page that needs one made. Pages outside
 * the list show nothing; the pager ends with the list, and [rememberStayInList] keeps it from going
 * before it.
 */
@Immutable
internal data class PageWindow(val first: Int, val ids: List<String>) {
    fun idAt(page: Int): String? = ids.getOrNull(page - first)

    /** Before any article, the page on screen and one each side, loaded and waiting. */
    val pageCount: Int
        get() = first + if (ids.isEmpty()) 2 else ids.size

    /** The nearest page in the list to [page], if [page] is outside it. */
    fun inList(page: Int): Int? =
        if (ids.isEmpty() || idAt(page) != null) null
        else page.coerceIn(first, first + ids.size - 1)

    companion object {
        /**
         * Where the pager starts: far enough from 0 for any list to open before it, and from the
         * end for any number of swipes after.
         */
        const val START = 1_000_000

        /** [opened] on page [at], or no article. EntryKey.openedFrom always lists the entry. */
        fun opening(opened: EntryKey?, at: Int): PageWindow =
            if (opened == null) PageWindow(at, emptyList())
            else PageWindow(at - opened.listIds.indexOf(opened.id), opened.listIds)

        val Saver: Saver<PageWindow, Any> =
            Saver(
                save = { arrayListOf<Any>(it.first, ArrayList(it.ids)) },
                restore = {
                    val (first, ids) = it as List<*>
                    PageWindow(first as Int, (ids as List<*>).map { id -> id as String })
                },
            )
    }
}

/**
 * Keeps drags and flings from taking the pager before [window]'s first page (TalkBack's page turns
 * get there anyway; [EntryScreen] brings those back).
 */
@Composable
internal fun rememberStayInList(pager: PagerState, window: PageWindow): NestedScrollConnection {
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    return remember(pager, window, rtl) {
        object : NestedScrollConnection {
            /** How far back a drag of [x] goes: a page's content moves right for the one before. */
            fun back(x: Float) = if (rtl) -x else x

            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                val pageWidth = pager.layoutInfo.pageSize + pager.layoutInfo.pageSpacing
                val room =
                    ((pager.currentPage - window.first) + pager.currentPageOffsetFraction) *
                        pageWidth
                val excess = back(available.x) - room.coerceAtLeast(0f)
                return if (window.ids.isEmpty() || excess <= 0f) Offset.Zero
                else Offset(back(excess), 0f)
            }

            override suspend fun onPreFling(available: Velocity): Velocity =
                if (
                    window.ids.isNotEmpty() &&
                        pager.currentPage <= window.first &&
                        back(available.x) > 0f
                )
                    available
                else Velocity.Zero
        }
    }
}
