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
        goOnTo(next(entryId) ?: return Silent.Ended)
        return Silent.GoneOn
    }

    enum class Silent {
        Stays,
        GoneOn,
        Ended,
    }

    /**
     * [entryId] has played to its end: the article narration goes on to, for the narrator to
     * [goOnTo] once it's ready to follow, or null to stop. Coming back to it starts it again.
     */
    fun finished(entryId: String): String? {
        if (left?.first == entryId) left = null
        return next(entryId)
    }

    /** Has the [list] open [next], for narration to follow. */
    fun goOnTo(next: String) {
        continuedTo = next
        list?.open(next)
    }

    private fun next(entryId: String): String? = list?.takeIf { goesOn() }?.after(entryId)
}
