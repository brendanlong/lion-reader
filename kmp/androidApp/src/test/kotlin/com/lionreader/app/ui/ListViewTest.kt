package com.lionreader.app.ui

import com.lionreader.shared.data.ListScope
import org.junit.Assert.assertEquals
import org.junit.Test

class ListViewTest {
    @Test
    fun selectingAListStartsItAfresh() {
        val view = ListView().keep("a").loadMore().select(ListScope.Starred)
        assertEquals(ListView(ListScope.Starred), view)
    }

    @Test
    fun keepingIsBoundedToTheMostRecent() {
        var view = ListView()
        repeat(250) { view = view.keep("$it") }
        view = view.keep("10")

        assertEquals(200, view.keepIds.size)
        assertEquals("10", view.keepIds.last())
        assertEquals(false, "49" in view.keepIds)
    }

    @Test
    fun lettingGoKeepsOnlyTheOpenArticle() {
        val view = ListView().keep("a").keep("b")
        assertEquals(setOf("b"), view.letGoOfKept(except = "b").keepIds)
        assertEquals(emptySet<String>(), view.letGoOfKept().keepIds)
    }

    @Test
    fun loadingMoreAddsAPage() {
        assertEquals(PAGE * 3, ListView().loadMore().loadMore().limit)
    }
}
