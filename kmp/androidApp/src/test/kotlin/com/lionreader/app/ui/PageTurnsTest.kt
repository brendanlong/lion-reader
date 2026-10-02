package com.lionreader.app.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PageTurnsTest {
    @Test
    fun theLatestScreenGetsTheTurnUntilItLeaves() {
        val turns = PageTurns()
        val list = mutableListOf<Int>()
        val article = mutableListOf<Int>()
        assertFalse("nothing to page", turns.turn(1))

        turns.register { list += it }
        val closeArticle = turns.register { article += it }
        assertTrue(turns.turn(1))
        assertTrue(turns.turn(-1))
        assertEquals(listOf(1, -1), article)
        assertEquals(emptyList<Int>(), list)

        closeArticle()
        turns.turn(1)
        assertEquals(listOf(1), list)
    }
}
