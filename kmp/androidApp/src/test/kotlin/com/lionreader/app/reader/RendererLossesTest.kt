package com.lionreader.app.reader

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RendererLossesTest {
    private var clock = 0L
    private val losses = RendererLosses { clock }

    @Test
    fun theSystemReclaimingRenderersNeverGivesUp() {
        repeat(10) { losses.lost(crashed = false) }

        assertFalse(losses.gaveUp)
        assertEquals(10, losses.generation)
    }

    @Test
    fun givesUpOnThreeCrashesWithinAMinute() {
        repeat(MAX_RENDERER_CRASHES - 1) {
            losses.lost(crashed = true)
            clock += 10_000
        }
        assertFalse(losses.gaveUp)
        losses.lost(crashed = true)

        assertTrue(losses.gaveUp)
        assertEquals(3, MAX_RENDERER_CRASHES)
    }

    @Test
    fun crashesFarApartDontAddUp() {
        repeat(5) {
            losses.lost(crashed = true)
            clock += CRASH_WINDOW_MILLIS
        }

        assertFalse(losses.gaveUp)
    }
}
