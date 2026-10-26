package com.lionreader.app.ui

import com.lionreader.shared.data.ArticleState
import com.lionreader.shared.data.Reader
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.launch

/**
 * The article a finger has just gone down on in a list, read while the tap completes (a tap holds
 * it down for most of 100 ms), so its page's first frame has it rather than one after. Each press
 * replaces the last; a read is used once, so a later visit doesn't start from an old one.
 */
internal class ArticlePrefetch(private val reader: Reader, private val scope: CoroutineScope) {
    private val read = MutableStateFlow<Pair<String, ArticleState>?>(null)
    private var reading: Job? = null

    fun press(id: String) {
        reading?.cancel()
        reading = scope.launch { read.value = id to reader.article(id).first() }
    }

    /** [id]'s article, if a press read it. */
    fun take(id: String): ArticleState? =
        read.getAndUpdate { if (it?.first == id) null else it }?.takeIf { it.first == id }?.second
}
