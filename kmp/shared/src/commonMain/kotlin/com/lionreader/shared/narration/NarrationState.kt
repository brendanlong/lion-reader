package com.lionreader.shared.narration

import com.lionreader.shared.data.EntryDetail

/** What to narrate: an article's paragraphs, as the reader's narration script extracted them. */
data class NarratedArticle(
    val entryId: String,
    val title: String,
    val source: String?,
    val paragraphs: List<String>,
) {
    companion object {
        fun of(entry: EntryDetail, paragraphs: List<String>) =
            NarratedArticle(entry.id, entry.title ?: "Untitled", entry.source, paragraphs)
    }
}

/**
 * Narration is on while there is a state: the article it's on, the paragraph being spoken (null
 * when narration has just followed to an article and has no place in it yet), and whether it's
 * playing or paused. The rest is derived ([derive]). [waiting]: it should be playing but has no
 * audio yet (the article's text hasn't been supplied, the engine is getting ready, or the next
 * chunk is still being synthesized). [canSkipBack] and [canSkipForward]: whether there's a
 * paragraph to skip to that way.
 */
data class NarrationState(
    val entryId: String,
    val title: String,
    val paragraph: Int?,
    val playing: Boolean,
    val waiting: Boolean = false,
    val canSkipBack: Boolean = false,
    val canSkipForward: Boolean = false,
)
