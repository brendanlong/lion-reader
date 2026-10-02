package com.lionreader.app.reader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RendererLossesTest {
    @Test
    fun theSystemReclaimingRenderersNeverGivesUp() {
        val losses = RendererLosses()

        repeat(10) { losses.lost(crashed = false) }

        assertFalse(losses.gaveUp)
        assertEquals(10, losses.generation)
    }

    @Test
    fun givesUpOnTheThirdCrashInARow() {
        val losses = RendererLosses()

        repeat(MAX_RENDERER_CRASHES - 1) { losses.lost(crashed = true) }
        assertFalse(losses.gaveUp)
        losses.lost(crashed = true)

        assertTrue(losses.gaveUp)
        assertEquals(3, MAX_RENDERER_CRASHES)
    }

    @Test
    fun aPageThatLoadedStartsCountingAgain() {
        val losses = RendererLosses()

        repeat(MAX_RENDERER_CRASHES - 1) { losses.lost(crashed = true) }
        losses.pageReady()
        repeat(MAX_RENDERER_CRASHES - 1) { losses.lost(crashed = true) }

        assertFalse(losses.gaveUp)
    }
}
