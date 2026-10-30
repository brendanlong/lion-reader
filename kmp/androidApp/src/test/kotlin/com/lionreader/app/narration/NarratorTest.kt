package com.lionreader.app.narration

import android.net.Uri
import android.os.Looper
import androidx.media3.common.Player
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.shared.narration.NEXT_ARTICLE
import com.lionreader.shared.narration.NO_MORE_ARTICLES
import com.lionreader.shared.narration.NarratedArticle
import com.lionreader.shared.narration.NarrationList
import com.lionreader.shared.narration.SpeechInterrupted
import com.lionreader.shared.settings.AppSettings
import java.io.File
import java.io.IOException
import java.time.Duration
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
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
    /** Syntheses that failed as unreachable. */
    private var unreached = 0
    /** Calls to fail as unreachable before the engine answers again; -1 for all of them. */
    private var unreachableFor = 0
    /** Getting the engine fails as unreachable while this is set. */
    private var engineUnreachable = false
    /** Texts whose next synthesis streams half its audio and waits: see [streamed]. */
    private val streamHalf = mutableSetOf<String>()
    /** Texts whose every synthesis streams half and then breaks off. */
    private val alwaysBreaks = mutableSetOf<String>()
    private val streamed = mutableListOf<Pair<StreamedAudio, File>>()
    /** Texts whose synthesis fails, so the chunk is skipped. */
    private val unsayable = mutableSetOf<String>()
    /** Synthesizes a moment of audio rather than half a minute, so narration can play through. */
    private var brief = false
    /** Getting the engine, and synthesis, wait on these while they're set. */
    private var engineReady: CompletableDeferred<Unit>? = null
    private var synthesisDone: CompletableDeferred<Unit>? = null

    private val engine =
        object : SpeechEngine {
            override val maxChunkChars = 400
            override val lookaheadChars = 1200
            override val parallelism = 1

            override suspend fun synthesize(text: String, dir: File, name: String): Uri {
                synthesisDone?.await()
                if (unreachableFor != 0) {
                    if (unreachableFor > 0) unreachableFor--
                    unreached++
                    throw SpeechInterrupted("Couldn't reach the cloud voice.")
                }
                synthesized += text
                if (text in unsayable) throw IOException("Can't say that")
                if (streamHalf.remove(text) || text in alwaysBreaks) {
                    val file = File(dir, "$name.part").apply { writeBytes(SILENCE.copyOf(HALF)) }
                    val audio = StreamedAudio(file).also { it.appended(HALF) }
                    streamed += audio to file
                    if (text in alwaysBreaks) breakOff(audio to file)
                    return audio.uri
                }
                val audio = if (brief) silence(seconds = 0.2) else SILENCE
                return Uri.fromFile(File(dir, "$name.wav").apply { writeBytes(audio) })
            }
        }

    // Off but in the tests of going on through the list, so the others' articles end as they say.
    private val settings = MutableStateFlow(AppSettings(narrationContinue = false))

    /** A list of [ids], recording where narration goes on to. */
    private class Listed(private val ids: List<String>) : NarrationList {
        val opened = mutableListOf<String>()

        override fun after(entryId: String): String? = ids.getOrNull(ids.indexOf(entryId) + 1)

        override fun open(entryId: String) {
            opened += entryId
        }
    }

    private val narrator =
        Narrator(
            ApplicationProvider.getApplicationContext(),
            settings,
            {
                engineReady?.await()
                if (engineUnreachable) throw SpeechInterrupted("Couldn't reach Lion Reader.")
                engine
            },
            // Robolectric can't bind media3's session service.
            connectSession = { {} },
        )

    /** Stops [audio] partway, as CloudVoices does: the half-written file goes too. */
    private fun breakOff(stream: Pair<StreamedAudio, File>) {
        stream.first.fail(IOException("Connection reset"))
        stream.second.delete()
    }

    /** Lets the player, which reports errors from its own thread, catch up until [done]. */
    private fun idleUntil(done: () -> Boolean) {
        repeat(100) {
            if (done()) return
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(100))
            Thread.sleep(10)
        }
    }

    private fun article(id: String, vararg paragraphs: String) =
        NarratedArticle(id, "Title $id", null, paragraphs.toList())

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()

    private val state
        get() = narrator.state.value

    @After fun stop() = narrator.stop()

    /**
     * Media3 keeps the service in the foreground, which the system won't let it enter from the
     * background, only while the player is to play and has something to buffer on.
     */
    private fun assertPlayerWaits() {
        assertTrue(narrator.player.mediaItemCount > 0)
        assertTrue(narrator.player.playWhenReady)
        assertEquals(Player.STATE_BUFFERING, narrator.player.playbackState)
    }

    @Test
    fun thePlayerWaitsOnSomethingFromTheStartThroughEachSynthesis() {
        engineReady = CompletableDeferred()
        synthesisDone = CompletableDeferred()
        narrator.narrate(article("a", "One."))
        idle()
        assertPlayerWaits()
        assertTrue(state!!.waiting)

        engineReady!!.complete(Unit)
        idle()
        assertPlayerWaits()
        assertEquals("0", narrator.player.currentMediaItem?.mediaId)

        synthesisDone!!.complete(Unit)
        idleUntil { narrator.player.playbackState == Player.STATE_READY }
        assertEquals(Player.STATE_READY, narrator.player.playbackState)
        assertFalse(state!!.waiting)
    }

    @Test
    fun thePlayerWaitsOnSomethingWhileFollowingToAnotherArticle() {
        narrator.narrate(article("a", "One."))
        idle()
        narrator.follow("b", "Title b")
        idle()
        assertPlayerWaits()

        synthesisDone = CompletableDeferred()
        narrator.supply(article("b", "Two."))
        idle()
        assertPlayerWaits()
        assertEquals("Title b", narrator.player.currentMediaItem?.mediaMetadata?.title)
    }

    @Test
    fun aChunkThatCantBeSaidIsSkippedWithoutThePlayerEnding() {
        unsayable += "One."
        narrator.narrate(article("a", "One.", "Two."))
        idleUntil { narrator.player.playbackState == Player.STATE_READY }

        assertEquals(
            listOf("1"),
            List(narrator.player.mediaItemCount) {
                narrator.player.getMediaItemAt(it).mediaId
            },
        )
        assertEquals(Player.STATE_READY, narrator.player.playbackState)
        assertEquals(1, state?.paragraph)
        assertTrue(state!!.playing)
    }

    @Test
    fun narrationStopsOnceItHasPlayedTheLastChunk() {
        brief = true
        unsayable += "Three."
        narrator.narrate(article("a", "One.", "Two.", "Three."))
        idleUntil { state == null }

        assertNull(state)
        assertEquals(listOf("One.", "Two.", "Three."), synthesized)
        assertEquals(0, narrator.player.mediaItemCount)
    }

    @Test
    fun atTheEndNarrationSaysSoAndGoesOnToTheNextArticle() {
        settings.value = AppSettings(narrationContinue = true)
        brief = true
        val list = Listed(listOf("a", "b")).also { narrator.list = it }
        narrator.narrate(article("a", "One."))
        idleUntil { list.opened.isNotEmpty() }

        assertEquals(listOf("b"), list.opened)
        assertEquals(listOf("One.", NEXT_ARTICLE), synthesized)
        // On until the article screen turns to the next, and narration follows it there.
        assertEquals("a", state?.entryId)
        assertPlayerWaits()

        synthesized.clear()
        narrator.follow("b", "Title b")
        narrator.supply(article("b", "Two."))
        idleUntil { state == null }
        assertEquals(listOf("Two.", NO_MORE_ARTICLES), synthesized)
        assertEquals(listOf("b"), list.opened)
    }

    @Test
    fun withoutGoingOnNarrationStopsAtTheEnd() {
        brief = true
        val list = Listed(listOf("a", "b")).also { narrator.list = it }
        narrator.narrate(article("a", "One."))
        idleUntil { state == null }

        assertEquals(listOf("One."), synthesized)
        assertTrue(list.opened.isEmpty())
    }

    @Test
    fun anArticleWithNothingToSayIsPassedOverOnTheWayThroughTheList() {
        settings.value = AppSettings(narrationContinue = true)
        brief = true
        val list = Listed(listOf("a", "b", "c")).also { narrator.list = it }
        narrator.narrate(article("a", "One."))
        idleUntil { list.opened.isNotEmpty() }
        narrator.follow("b", "Title b")
        narrator.supply(article("b", " ", "↩"))
        idle()

        assertEquals(listOf("b", "c"), list.opened)
        assertPlayerWaits()
    }

    @Test
    fun aSilentArticleEndingTheListEndsNarration() {
        settings.value = AppSettings(narrationContinue = true)
        brief = true
        val list = Listed(listOf("a", "b")).also { narrator.list = it }
        narrator.narrate(article("a", "One."))
        idleUntil { list.opened.isNotEmpty() }
        narrator.follow("b", "Title b")
        narrator.supply(article("b", " "))
        idle()

        assertNull(state)
    }

    @Test
    fun anArticleWithNothingToSayFollowedToByHandIsNotPassedOver() {
        settings.value = AppSettings(narrationContinue = true)
        val list = Listed(listOf("a", "b", "c")).also { narrator.list = it }
        narrator.narrate(article("a", "One."))
        idle()
        narrator.follow("b", "Title b")
        narrator.supply(article("b", " ", "↩"))
        idle()

        assertTrue(list.opened.isEmpty())
        assertEquals("b", state?.entryId)
    }

    @Test
    fun comingBackToAFinishedArticleStartsItAgain() {
        settings.value = AppSettings(narrationContinue = true)
        brief = true
        val list = Listed(listOf("a", "b")).also { narrator.list = it }
        narrator.narrate(article("a", "One.", "Two."))
        idleUntil { list.opened.isNotEmpty() }
        narrator.follow("b", "Title b")
        narrator.follow("a", "Title a")

        assertNull(state?.paragraph)
        synthesized.clear()
        narrator.supply(article("a", "One.", "Two."))
        idle()
        assertEquals(0, state?.paragraph)
        assertEquals("One.", synthesized.first())
    }

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
    fun startingAfterTheLastParagraphWithSomethingToSayPlaysTheLastOne() {
        narrator.narrate(article("a", "One.", "Two.", "↩"), fromParagraph = 2)
        idle()

        assertEquals(listOf("Two."), synthesized)
        assertEquals(1, state?.paragraph)
    }

    @Test
    fun anArticleWithNothingToSayLeavesNarrationOnForTheNext() {
        narrator.narrate(article("a", "One."))
        idle()
        narrator.follow("b", "Title b")
        narrator.supply(article("b", " ", "↩"))
        idle()

        assertEquals("b", state?.entryId)
        assertFalse(state!!.waiting)
        // Nothing for the media controls to play (and wait on forever).
        assertEquals(0, narrator.player.mediaItemCount)
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
        narrator.skipParagraphs(-1)
        assertEquals(0, state?.paragraph)
        narrator.skipParagraphs(1)
        narrator.skipParagraphs(1)
        assertEquals(2, state?.paragraph)
        assertFalse(state!!.canSkipForward)
        narrator.skipParagraphs(1)
        assertEquals(2, state?.paragraph)
    }

    @Test
    fun theSkipsFollowTheArticleSuppliedWhilePaused() {
        narrator.narrate(article("a", "One."))
        idle()
        narrator.togglePlaying()
        // The title is already the article's, so supplying it changes only what can be skipped.
        narrator.follow("b", "Title b")
        assertFalse(state!!.canSkipForward)
        assertFalse(state!!.canSkipBack)

        narrator.supply(article("b", "One.", "Two."))

        assertTrue(state!!.canSkipForward)
        assertFalse(state!!.canSkipBack)
        narrator.skipParagraphs(1)
        assertTrue(state!!.canSkipForward)
        assertFalse(state!!.canSkipBack)
        narrator.skipParagraphs(1)
        assertFalse(state!!.canSkipForward)
        assertTrue(state!!.canSkipBack)
    }

    @Test
    fun skippingPastEitherEndDoesNothing() {
        narrator.narrate(article("a", "One.", "", "Three."))
        idle()
        assertFalse(state!!.canSkipBack)
        assertTrue(state!!.canSkipForward)
        val playing = narrator.player.currentMediaItem
        narrator.skipParagraphs(-1)
        idle()
        // Not even the paragraph started over: the player wasn't touched.
        assertEquals(playing, narrator.player.currentMediaItem)
        assertEquals(0, state?.paragraph)

        // The blank paragraph has nothing to say, so it's skipped over.
        narrator.skipParagraphs(1)
        idle()
        assertEquals(2, state?.paragraph)
        assertFalse(state!!.canSkipForward)
        narrator.skipParagraphs(1)
        idle()
        assertEquals(2, state?.paragraph)
        assertTrue(state!!.playing)
    }

    @Test
    fun mediaControlsMoveByParagraphAndOfferOnlyWhereThereIsOne() {
        narrator.narrate(article("a", "One.", "Two."))
        idle()
        val player = SessionPlayer(narrator)
        val heard = mutableListOf<Player.Commands>()
        val playing = mutableListOf<Boolean>()
        player.addListener(
            object : Player.Listener {
                override fun onAvailableCommandsChanged(availableCommands: Player.Commands) {
                    heard += availableCommands
                }

                override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                    playing += playWhenReady
                }
            }
        )
        // The player's own events still come through.
        narrator.togglePlaying()
        narrator.togglePlaying()
        idle()
        assertEquals(listOf(false, true), playing)

        assertFalse(player.isCommandAvailable(Player.COMMAND_SEEK_TO_PREVIOUS))
        assertTrue(player.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT))

        player.seekToNext()
        idle()
        assertEquals(1, state?.paragraph)
        player.skipsChanged()
        assertTrue(player.isCommandAvailable(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM))
        assertFalse(player.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM))
        assertTrue(heard.last().contains(Player.COMMAND_SEEK_TO_PREVIOUS))
        assertFalse(heard.last().contains(Player.COMMAND_SEEK_TO_NEXT))

        player.seekToNextMediaItem()
        idle()
        assertEquals(1, state?.paragraph)
        player.seekToPrevious()
        idle()
        assertEquals(0, state?.paragraph)
        player.detach()
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
    fun listeningFromASelectionStartsThere() {
        narrator.listenFrom(article("a", "One.", "Two.", "Three."), 1)
        idle()

        assertEquals("a", state?.entryId)
        assertTrue(state!!.playing)
        assertEquals(listOf("Two.", "Three."), synthesized)
    }

    @Test
    fun listeningFromASelectionInThePausedArticleGoesThereAndPlays() {
        narrator.narrate(article("a", "One.", "Two.", "Three."))
        idle()
        narrator.togglePlaying()
        idle()
        assertFalse(state!!.playing)

        narrator.listenFrom(article("a", "One.", "Two.", "Three."), 2)
        idle()
        assertTrue(state!!.playing)
        assertEquals(2, state?.paragraph)
    }

    @Test
    fun listeningFromASelectionInAFollowedArticleNotYetSuppliedUsesItsText() {
        narrator.narrate(article("a", "One."))
        idle()
        narrator.togglePlaying()
        narrator.follow("b", "Title b")
        synthesized.clear()

        narrator.listenFrom(article("b", "Four.", "Five."), 1)
        idle()
        assertTrue(state!!.playing)
        assertEquals(listOf("Five."), synthesized)
    }

    @Test
    fun speechThatStopsPartwayIsSaidAgainFromTheStartOfItsChunk() {
        streamHalf += "One."
        narrator.narrate(article("a", "One.", "Two."))
        idle()
        breakOff(streamed.single())

        idleUntil { synthesized.count { it == "One." } == 2 }
        assertEquals(2, synthesized.count { it == "One." })
        assertEquals("a", state?.entryId)
        assertTrue(state!!.playing)
        assertEquals(0, state?.paragraph)
    }

    @Test
    fun stoppingEndsTheTriesToSaySpeechAgain() {
        streamHalf += "One."
        narrator.narrate(article("a", "One.", "Two."))
        idle()
        unreachableFor = -1
        breakOff(streamed.single())
        idleUntil { unreached > 0 }
        narrator.stop()
        val tried = unreached

        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMinutes(5))
        assertEquals(tried, unreached)
    }

    @Test
    fun speechThatKeepsStoppingPartwayIsSkippedAfterTwoMoreTries() {
        alwaysBreaks += "One."
        narrator.narrate(article("a", "One.", "Two."))
        idleUntil { state?.paragraph == 1 }

        assertEquals(3, synthesized.count { it == "One." })
        assertEquals(1, state?.paragraph)
        assertTrue(state!!.playing)
    }

    @Test
    fun theSpeedFollowsTheSetting() {
        settings.value = AppSettings(narrationSpeed = 1.5f)
        narrator.narrate(article("a", "One.", "Two."))
        idle()
        assertEquals(1.5f, narrator.player.playbackParameters.speed)

        settings.value = AppSettings(narrationSpeed = 2f)
        idle()
        assertEquals(2f, narrator.player.playbackParameters.speed)
        // Starting again elsewhere keeps it.
        narrator.follow("b", "Title b")
        narrator.supply(article("b", "Three."))
        idle()
        assertEquals(2f, narrator.player.playbackParameters.speed)
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
private val SILENCE: ByteArray by lazy { silence(seconds = 30.0) }

private fun silence(seconds: Double): ByteArray {
    val rate = 8_000
    val samples = (rate * seconds).toInt()
    return java.nio.ByteBuffer.allocate(44 + samples)
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

private val HALF = SILENCE.size / 2
