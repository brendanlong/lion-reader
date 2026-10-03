package com.lionreader.app.ui

import com.lionreader.shared.data.ListScope
import org.junit.Assert.assertEquals
import org.junit.Test

class ListStateTest {
    @Test
    fun selectingAListStartsItAfresh() {
        val view = ListState().keep("a").loadMore().select(ListScope.Starred)
        assertEquals(ListState(ListScope.Starred), view)
    }

    @Test
    fun keepingIsBoundedToTheMostRecent() {
        var view = ListState()
        repeat(250) { view = view.keep("$it") }
        // Touching a kept one again makes it the most recent.
        view = view.keep("100")
        view = view.keep("new")

        assertEquals(200, view.keepIds.size)
        assertEquals(listOf("100", "new"), view.keepIds.toList().takeLast(2))
        // The oldest goes: 50, not 100.
        assertEquals(false, "50" in view.keepIds)
        assertEquals(true, "51" in view.keepIds)
    }

    @Test
    fun lettingGoKeepsOnlyTheOpenArticle() {
        val view = ListState().keep("a").keep("b")
        assertEquals(setOf("b"), view.letGoOfKept(except = "b").keepIds)
        assertEquals(emptySet<String>(), view.letGoOfKept().keepIds)
    }

    @Test
    fun loadingMoreAddsAPage() {
        assertEquals(ListState.PAGE * 3, ListState().loadMore().loadMore().limit)
    }
}
