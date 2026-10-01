package com.lionreader.app.narration

import android.os.Looper
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.app.AppSettings
import java.io.File
import java.time.Duration
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don't need.
@Config(application = android.app.Application::class)
class NarratorTest {
    private val synthesized = mutableListOf<String>()
    /** Calls to fail as unreachable before the engine answers again; -1 for all of them. */
    private var unreachableFor = 0
    /** Getting the engine fails as unreachable while this is set. */
    private var engineUnreachable = false

    private val engine =
        object : SpeechEngine {
            override val maxChunkChars = 400
            override val lookaheadChars = 1200
            override val parallelism = 1

            override suspend fun synthesize(text: String, dir: File, name: String): File {

                if (unreachableFor != 0) {
                    if (unreachableFor > 0) unreachableFor--
                    throw SpeechInterrupted("Couldn't reach the cloud voice.")
                }
                synthesized += text
                return File(dir, "$name.wav").apply { writeBytes(SILENCE) }
            }
        }

    private val narrator =
        Narrator(
            ApplicationProvider.getApplicationContext(),
            { AppSettings() },
            {
                if (engineUnreachable) throw SpeechInterrupted("Couldn't reach Lion Reader.")
                engine
            },
            // Robolectric can't bind media3's session service.
            connectSession = { {} },
        )

    private fun article(id: String, vararg paragraphs: String) =
        NarratedArticle(id, "Title $id", null, paragraphs.toList())

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private val state
        get() = narrator.state.value

    @After fun stop() = narrator.stop()

    @Test
    fun followingMovesNarrationAndKeepsItPlaying() {
        narrator.narrate(article("a", "One."))
        idle()
        narrator.follow("b", "Title b")

        assertEquals("b", state?.entryId)
        assertTrue(state!!.playing)
        assertTrue(state!!.waiting)
        // No place in the new article (nothing highlighted) before its text.
        assertNull(state!!.paragraph)

        synthesized.clear()
        narrator.supply(article("b", "Two."))
        idle()
        assertEquals(listOf("Two."), synthesized)
        assertEquals(0, state?.paragraph)
    }

    @Test
    fun aPausedNarrationFollowsWithoutSynthesizingUntilItPlays() {
        narrator.narrate(article("a", "One."))
        idle()
        narrator.togglePlaying()
        narrator.follow("b", "Title b")
        synthesized.clear()
        narrator.supply(article("b", "Two."))
        idle()

        assertEquals("b", state?.entryId)
        assertFalse(state!!.playing)
        assertFalse(state!!.waiting)
        assertNull(state!!.paragraph)
        assertTrue(synthesized.isEmpty())

        narrator.togglePlaying()
        idle()
        assertTrue(state!!.playing)
        assertEquals(listOf("Two."), synthesized)
    }

    @Test
    fun followingBackResumesWhereItLeft() {
        narrator.narrate(article("a", "One.", "Two.", "Three."), fromParagraph = 2)
        idle()
        narrator.follow("b", "Title b")
        narrator.follow("c", "Title c")
        narrator.follow("a", "Title a")

        assertEquals(2, state?.paragraph)
    }

    @Test
    fun anArticleWithNothingToSayLeavesNarrationOnForTheNext() {
        narrator.narrate(article("a", "One."))
        idle()
        narrator.follow("b", "Title b")
        narrator.supply(article("b", " "))
        idle()

        assertEquals("b", state?.entryId)
        assertFalse(state!!.waiting)
        narrator.togglePlaying()
        narrator.togglePlaying()
        assertFalse(state!!.waiting)

        synthesized.clear()
        narrator.follow("c", "Title c")
        narrator.supply(article("c", "Three."))
        idle()
        assertEquals(listOf("Three."), synthesized)
    }

    @Test
    fun skippingWorksBeforeTheAudioIsPrepared() {
        narrator.narrate(article("a", "One."))
        idle()
        narrator.togglePlaying()
        narrator.follow("b", "Title b")
        narrator.supply(article("b", "One.", "Two.", "Three."))
        narrator.skipParagraphs(1)
        assertEquals(0, state?.paragraph)
        narrator.skipParagraphs(1)
        assertEquals(1, state?.paragraph)
        narrator.skipParagraphs(5)
        assertEquals(2, state?.paragraph)
    }

    @Test
    fun aDroppedConnectionIsTriedAgainNotTheEnd() {
        unreachableFor = 2
        narrator.narrate(article("a", "One."))
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(10))

        assertEquals(listOf("One."), synthesized)
        assertNull(narrator.notice.value)
    }

    @Test
    fun outOfReachBeforeTheAudioIsPreparedPausesToo() {
        engineUnreachable = true
        narrator.narrate(article("a", "One."))
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(100))
        assertEquals("a", state?.entryId)
        assertFalse(state!!.playing)
        assertFalse(state!!.waiting)
        assertTrue(narrator.notice.value!!.startsWith("Narration paused"))

        engineUnreachable = false
        narrator.togglePlaying()
        assertNull(narrator.notice.value)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        assertEquals(listOf("One."), synthesized)
    }

    @Test
    fun anEngineOutOfReachForLongPausesNarrationRatherThanEndingIt() {
        unreachableFor = -1
        narrator.narrate(article("a", "One."))
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(30))
        assertTrue(state!!.playing)

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(70))
        assertEquals("a", state?.entryId)
        assertFalse(state!!.playing)
        assertTrue(narrator.notice.value!!.startsWith("Narration paused"))

        // Played again, it tries again at once (not after the backoff it was in).
        unreachableFor = 0
        narrator.togglePlaying()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
        assertEquals(listOf("One."), synthesized)
        assertNull(narrator.notice.value)
    }

    @Test
    fun followingDoesNothingWhileNarrationIsOff() {
        narrator.follow("b", "Title b")
        narrator.supply(article("b", "Two."))
        idle()

        assertNull(state)
        assertTrue(synthesized.isEmpty())
    }
}

/**
 * Half a minute of silence, as a real WAV: an empty file makes the player report an error (on its
 * own thread, so at any point in a test), which ends the narration.
 */
private val SILENCE: ByteArray by lazy {
    val rate = 8_000
    val samples = rate * 30
    java.nio.ByteBuffer.allocate(44 + samples)
        .order(java.nio.ByteOrder.LITTLE_ENDIAN)
        .apply {
            put("RIFF".toByteArray()).putInt(36 + samples).put("WAVE".toByteArray())
            put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1)
            putInt(rate).putInt(rate).putShort(1).putShort(8)
            put("data".toByteArray()).putInt(samples)
            // 8-bit PCM is unsigned: 128 is silence.
            repeat(samples) { put(128.toByte()) }
        }
        .array()
}
