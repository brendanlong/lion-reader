package com.lionreader.app.ui

/** How far a page turn moves: some of the last page stays in view, to read on from. */
const val PAGE_FRACTION = 2f / 3

/**
 * What the volume buttons page through: each scrolling screen registers while it's showing, and the
 * latest (the article, over the list it was opened from) gets the turn. [turn]'s direction is 1 for
 * down the page, -1 for up.
 */
class PageTurns {
    private val targets = mutableListOf<(Int) -> Unit>()

    /** Registers [target]; the returned function unregisters it. */
    fun register(target: (Int) -> Unit): () -> Unit {
        targets += target
        return { targets.remove(target) }
    }

    /** Turns the page on the screen on top; false when nothing that pages is showing. */
    fun turn(direction: Int): Boolean {
        val target = targets.lastOrNull() ?: return false
        target(direction)
        return true
    }
}
