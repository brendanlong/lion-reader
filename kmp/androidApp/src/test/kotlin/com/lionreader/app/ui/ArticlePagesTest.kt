package com.lionreader.app.ui

import com.lionreader.shared.data.EntryDetail
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ArticlePagesTest {
    private fun entry(id: String) =
        EntryDetail(
            id = id,
            title = "Title $id",
            author = null,
            source = null,
            url = null,
            sortAtMillis = 0,
            read = false,
            starred = false,
            content = "<p>Body</p>",
            summary = null,
        )

    @Test
    fun anArticleThatsGoneTakesItsExtractedTextWithIt() {
        val pages = ArticlePages()
        pages.loaded("a", entry("a"))
        pages.extracted("a", listOf("Hello."))
        assertEquals(listOf("Hello."), pages.paragraphs("a"))

        pages.loaded("a", null)
        assertNull(pages.entry("a"))
        assertNull(pages.paragraphs("a"))
    }

    @Test
    fun summarizingStartsOnceAndShowsTheSummary() {
        val pages = ArticlePages()
        assertTrue(pages.startSummarizing("a"))
        assertFalse(pages.startSummarizing("a"))
        assertTrue(pages.isSummarizing("a"))
        assertTrue(pages.summaryShown("a"))

        pages.doneSummarizing("a")
        assertFalse(pages.isSummarizing("a"))
        assertTrue(pages.startSummarizing("a"))
    }

    @Test
    fun summariesStartHiddenToggleAndTheShownOnesAreSaved() {
        val pages = ArticlePages()
        assertFalse(pages.summaryShown("a"))
        pages.toggleSummary("a")
        assertTrue(pages.summaryShown("a"))

        val restored = ArticlePages(pages.shownSummaries)
        assertTrue(restored.summaryShown("a"))
        restored.toggleSummary("a")
        assertFalse(restored.summaryShown("a"))
    }
}
