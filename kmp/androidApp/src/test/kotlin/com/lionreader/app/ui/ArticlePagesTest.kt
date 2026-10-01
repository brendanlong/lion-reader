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
        val pages = ArticlePages(hiddenSummaries = setOf("a"))
        assertTrue(pages.startSummarizing("a"))
        assertFalse(pages.startSummarizing("a"))
        assertTrue(pages.isSummarizing("a"))
        assertTrue(pages.summaryShown("a"))

        pages.doneSummarizing("a")
        assertFalse(pages.isSummarizing("a"))
        assertTrue(pages.startSummarizing("a"))
    }

    @Test
    fun summariesToggleAndTheHiddenOnesAreSaved() {
        val pages = ArticlePages()
        pages.toggleSummary("a")
        assertFalse(pages.summaryShown("a"))

        val restored = ArticlePages(pages.hiddenSummaries)
        assertFalse(restored.summaryShown("a"))
        restored.toggleSummary("a")
        assertTrue(restored.summaryShown("a"))
    }
}
