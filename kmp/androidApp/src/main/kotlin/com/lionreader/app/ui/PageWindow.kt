package com.lionreader.app.ui

import androidx.compose.foundation.pager.PagerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.Saver
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.ScrollAxisRange
import androidx.compose.ui.semantics.horizontalScrollAxisRange
import androidx.compose.ui.semantics.pageLeft
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.Velocity
import com.lionreader.app.EntryKey
import kotlinx.coroutines.launch

/**
 * Which article each of the article pager's pages shows: the list's [ids], from page [first] on.
 * The pager outlives openings ([EntryScreen]), so an article opens on the page already on screen
 * ([opening]), whose WebView swaps it in, rather than on a page that needs one made. Pages outside
 * the list show nothing; the pager ends with the list, and [stayInList] keeps it from going before
 * it.
 */
@Immutable
internal data class PageWindow(val first: Int, val ids: List<String>) {
    fun idAt(page: Int): String? = ids.getOrNull(page - first)

    /** Before any article, the page on screen and one each side, loaded and waiting. */
    val pageCount: Int
        get() = first + if (ids.isEmpty()) 2 else ids.size

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
 * Keeps the pager from going before [window]'s first page: drags and flings, and TalkBack's page
 * turns, which go through the pager's semantics rather than scrolling. The pager puts its own
 * semantics inside the modifier it's given, so these replace them.
 */
@Composable
internal fun Modifier.stayInList(pager: PagerState, window: PageWindow): Modifier {
    if (window.ids.isEmpty()) return this
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    val scope = rememberCoroutineScope()
    val connection =
        remember(pager, window, rtl) {
            object : NestedScrollConnection {
                /**
                 * How far back a drag of [x] goes: a page's content moves right for the one before.
                 */
                fun back(x: Float) = if (rtl) -x else x

                override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                    val excess = back(available.x) - pager.roomBefore(window).coerceAtLeast(0f)
                    return if (excess <= 0f) Offset.Zero else Offset(back(excess), 0f)
                }

                override suspend fun onPreFling(available: Velocity): Velocity =
                    if (pager.currentPage <= window.first && back(available.x) > 0f) available
                    else Velocity.Zero
            }
        }
    return nestedScroll(connection).semantics {
        horizontalScrollAxisRange =
            ScrollAxisRange(
                value = { pager.roomBefore(window).coerceAtLeast(0f) },
                maxValue = { (window.ids.size - 1) * pager.pageWidth },
            )
        // The pager's page left is always the page before, even right to left.
        pageLeft {
            val back = pager.currentPage > window.first
            if (back) scope.launch { pager.animateScrollToPage(pager.currentPage - 1) }
            back
        }
    }
}

private val PagerState.pageWidth: Float
    get() = (layoutInfo.pageSize + layoutInfo.pageSpacing).toFloat()

/** How far the pager can scroll back before leaving [window]'s list. */
private fun PagerState.roomBefore(window: PageWindow): Float =
    ((currentPage - window.first) + currentPageOffsetFraction) * pageWidth
