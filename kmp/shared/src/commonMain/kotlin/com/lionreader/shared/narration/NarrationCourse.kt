package com.lionreader.shared.narration

import com.lionreader.shared.api.NarrationCues

/**
 * Where narration goes from one article to the next, apart from the player: the place to resume an
 * article at, and the list it goes on through when one ends, so each platform's narrator goes the
 * same way. [goesOn]: whether narration goes on through the [list] at all (the setting).
 */
class NarrationCourse(private val goesOn: () -> Boolean) {
    /**
     * The list narration goes on through when an article ends: the article screen's, while it's
     * shown. Without one, narration stops at the end.
     */
    var list: NarrationList? = null

    /**
     * The article narration last followed away from, and where it was, to resume on coming back.
     */
    private var left: Pair<String, Int>? = null

    /** The article narration went on to from the end of the one before. */
    private var continuedTo: String? = null

    /** Narration started on an article the reader chose. */
    fun started() {
        continuedTo = null
    }

    fun stopped() {
        continuedTo = null
        left = null
    }

    /** Narration follows the reader [from] where it was to [entryId]: where to resume there. */
    fun follow(from: NarrationState, entryId: String): Int? {
        if (entryId != continuedTo) continuedTo = null
        val resume = left?.takeIf { it.first == entryId }?.second
        // An article passed through without a place doesn't replace the one remembered.
        from.paragraph?.let { left = from.entryId to it }
        return resume
    }

    /** What narration says after [entryId]'s own "End of article.", for what comes next. */
    fun closing(entryId: String): List<String> =
        when {
            !goesOn() -> emptyList()
            list?.after(entryId) != null -> listOf(NarrationCues.NEXT_ARTICLE)
            else -> listOf(NarrationCues.NO_MORE_ARTICLES)
        }

    /**
     * [entryId] has nothing to say. Passed over on the way through the list, narration goes on to
     * the next ([Silent.GoneOn]) or, at its end, stops ([Silent.Ended]); followed to by the reader,
     * it stays on, for the next ([Silent.Stays]).
     */
    fun silent(entryId: String): Silent {
        if (continuedTo != entryId) return Silent.Stays
        return if (goOn(entryId)) Silent.GoneOn else Silent.Ended
    }

    enum class Silent {
        Stays,
        GoneOn,
        Ended,
    }

    /**
     * [entryId] has played to its end. Whether narration goes on to the next article, which the
     * [list] then opens for narration to follow; otherwise it stops. Coming back to it starts it
     * again.
     */
    fun finished(entryId: String): Boolean {
        if (left?.first == entryId) left = null
        return goOn(entryId)
    }

    private fun goOn(entryId: String): Boolean {
        val list = list?.takeIf { goesOn() } ?: return false
        val next = list.after(entryId) ?: return false
        continuedTo = next
        list.open(next)
        return true
    }
}
