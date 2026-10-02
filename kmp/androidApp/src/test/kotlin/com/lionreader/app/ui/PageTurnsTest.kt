package com.lionreader.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PageTurnsTest {
    private val turns = PageTurns()
    private val list = mutableListOf<Int>()
    private val article = mutableListOf<Int>()

    private fun register(layer: PageLayer, into: MutableList<Int>) =
        turns.register(layer) {
            into += it
            true
        }

    @Test
    fun theArticleGetsTheTurnUntilItLeaves() {
        assertFalse("nothing to page", turns.turn(1))
        register(PageLayer.LIST, list)
        val closeArticle = register(PageLayer.ARTICLE, article)
        assertTrue(turns.turn(1))
        assertTrue(turns.turn(-1))
        assertEquals(listOf(1, -1), article)
        assertEquals(emptyList<Int>(), list)

        closeArticle()
        turns.turn(1)
        assertEquals(listOf(1), list)
    }

    @Test
    fun aListRegisteringAgainDoesNotTakeTheTurnFromTheArticle() {
        // Beside the list: the drawer closing (or a search) registers the list anew.
        register(PageLayer.ARTICLE, article)
        val first = register(PageLayer.LIST, list)
        first()
        register(PageLayer.LIST, list)
        turns.turn(1)
        assertEquals(listOf(1), article)
        assertEquals(emptyList<Int>(), list)
    }

    @Test
    fun aTargetThatCantTurnYetLetsTheButtonBeAVolumeButton() {
        turns.register(PageLayer.ARTICLE) { false }
        assertFalse(turns.turn(1))
    }
}
