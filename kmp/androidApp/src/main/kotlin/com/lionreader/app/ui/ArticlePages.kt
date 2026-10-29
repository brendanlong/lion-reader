package com.lionreader.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import com.lionreader.shared.data.EntryDetail

/**
 * What the article screen knows of each of its pages, changed only through the functions here: the
 * article as its page loaded it (so the bars can follow the page a swipe is heading to), the text
 * its reader extracted to narrate, and its summary's state.
 */
@Stable
internal class ArticlePages(shownSummaries: Set<String> = emptySet()) {
    private val entries = mutableStateMapOf<String, EntryDetail>()
    private val spoken = mutableStateMapOf<String, List<String>>()
    /** Summaries the user asked to see; hidden until then, like on the web. Kept across rotation. */
    var shownSummaries by mutableStateOf(shownSummaries)
        private set

    private var summarizing by mutableStateOf(emptySet<String>())

    fun entry(id: String): EntryDetail? = entries[id]

    fun paragraphs(id: String): List<String>? = spoken[id]

    /** A page's article, or null when it's gone (and with it, its extracted text). */
    fun loaded(id: String, entry: EntryDetail?) {
        if (entry == null) {
            entries.remove(id)
            spoken.remove(id)
        } else {
            entries[id] = entry
        }
    }

    fun extracted(id: String, paragraphs: List<String>) {
        spoken[id] = paragraphs
    }

    fun summaryShown(id: String): Boolean = id in shownSummaries

    fun isSummarizing(id: String): Boolean = id in summarizing

    fun toggleSummary(id: String) {
        shownSummaries = if (id in shownSummaries) shownSummaries - id else shownSummaries + id
    }

    /** Whether to start summarizing [id]: not if it already is. Its summary shows when done. */
    fun startSummarizing(id: String): Boolean {
        if (id in summarizing) return false
        summarizing += id
        shownSummaries += id
        return true
    }

    fun doneSummarizing(id: String) {
        summarizing -= id
    }

    companion object {
        val saver: Saver<ArticlePages, ArrayList<String>> =
            Saver(
                save = { ArrayList(it.shownSummaries) },
                restore = { ArticlePages(it.toSet()) },
            )
    }
}

@Composable
internal fun rememberArticlePages(visit: Any?): ArticlePages =
    rememberSaveable(visit, saver = ArticlePages.saver) { ArticlePages() }
