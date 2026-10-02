package com.lionreader.app.ui

/**
 * How far a page turn moves: as browsers' Page Down (Chromium's is 0.875), so the last couple of
 * lines stay in view to read on from.
 */
const val PAGE_FRACTION = 0.875f

/** Which page turners win: an article's, over the list it was opened from (beside it, too). */
enum class PageLayer {
    LIST,
    ARTICLE,
}

/**
 * What the volume buttons page through: each scrolling screen registers while it's showing, and the
 * top [PageLayer]'s latest gets the turn. A target turns down the page for 1 and up for -1, and
 * says whether it could (it can't before it's laid out).
 */
class PageTurns {
    private class Target(val layer: PageLayer, val turn: (Int) -> Boolean)

    private val targets = mutableListOf<Target>()

    /** Registers [turn]; the returned function unregisters it. */
    fun register(layer: PageLayer, turn: (Int) -> Boolean): () -> Unit {
        val target = Target(layer, turn)
        targets += target
        return { targets.remove(target) }
    }

    /** Turns the page on top; false when nothing that pages is showing. */
    fun turn(direction: Int): Boolean {
        val top = targets.maxOfOrNull { it.layer } ?: return false
        return targets.last { it.layer == top }.turn(direction)
    }
}
