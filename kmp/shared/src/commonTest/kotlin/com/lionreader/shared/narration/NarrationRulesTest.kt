package com.lionreader.shared.narration

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NarrationRulesTest {
    private fun chunk(paragraph: Int) = SpeechChunk(paragraph, "Text.")

    @Test
    fun theSpokenParagraphsAreTheChunksOnceThereAreSome() {
        assertEquals(
            listOf(0, 2),
            spokenParagraphs(listOf(chunk(0), chunk(0), chunk(2)), listOf("A", "B", "C")),
        )
    }

    @Test
    fun beforeThenTheArticlesParagraphsWithSomethingToSay() {
        assertEquals(listOf(0, 2), spokenParagraphs(null, listOf("A", " ", "C", "↩")))
        assertNull(spokenParagraphs(null, null))
    }

    @Test
    fun skippingMovesAmongTheSpokenParagraphs() {
        val spoken = listOf(0, 2, 5)
        assertEquals(2, paragraphAfter(spoken, 0, 1))
        assertEquals(5, paragraphAfter(spoken, 0, 2))
        assertEquals(2, paragraphAfter(spoken, 5, -1))
        // From a paragraph with nothing to say.
        assertEquals(2, paragraphAfter(spoken, 1, 1))
        assertEquals(0, paragraphAfter(spoken, 1, -1))
    }

    @Test
    fun skippingGoesNowherePastEitherEnd() {
        val spoken = listOf(0, 2)
        assertNull(paragraphAfter(spoken, 0, -1))
        assertNull(paragraphAfter(spoken, 2, 1))
        assertNull(paragraphAfter(spoken, 0, 2))
        assertNull(paragraphAfter(emptyList(), 0, 1))
    }

    @Test
    fun withNoPlaceYetNextIsTheFirstParagraph() {
        assertEquals(0, paragraphAfter(listOf(0, 2), null, 1))
        assertNull(paragraphAfter(listOf(0, 2), null, -1))
    }

    private fun player(state: PlaybackState, items: Int = 3) = PlayerSnapshot(state, items)

    @Test
    fun beforeTheAudioIsPreparedItWaitsOnlyToPlaySomething() {
        assertTrue(isWaiting(playing = true, silent = false, player = null))
        assertFalse(isWaiting(playing = false, silent = false, player = null))
        assertFalse(isWaiting(playing = true, silent = true, player = null))
    }

    @Test
    fun afterItWaitsForAudioThePlayerHasntGot() {
        assertFalse(isWaiting(true, false, player(PlaybackState.READY)))
        assertTrue(isWaiting(true, false, player(PlaybackState.READY, items = 0)))
        assertTrue(isWaiting(true, false, player(PlaybackState.BUFFERING)))
        assertTrue(isWaiting(true, false, player(PlaybackState.IDLE)))
        assertFalse(isWaiting(true, false, player(PlaybackState.ENDED)))
        // Paused, the player's state still says whether there's audio.
        assertTrue(isWaiting(false, false, player(PlaybackState.BUFFERING)))
    }

    @Test
    fun theDerivedStateSaysWhichWaysItCanSkip() {
        val state = NarrationState("a", "Title", paragraph = 2, playing = false)
        val middle = derive(state, listOf(0, 2, 5), silent = false, player = null)
        assertTrue(middle.canSkipBack)
        assertTrue(middle.canSkipForward)
        assertFalse(middle.waiting)

        val last = derive(state.copy(paragraph = 5), listOf(0, 2, 5), false, null)
        assertTrue(last.canSkipBack)
        assertFalse(last.canSkipForward)

        val noArticle = derive(state.copy(playing = true), null, false, null)
        assertFalse(noArticle.canSkipBack)
        assertFalse(noArticle.canSkipForward)
        assertTrue(noArticle.waiting)
    }

    @Test
    fun synthesisKeepsALookaheadOfCharactersAheadOfThePlayer() {
        // Five chunks of 100 characters.
        val offsets = intArrayOf(0, 100, 200, 300, 400, 500)
        val queued = 2
        // The next chunk always; past it, while within the lookahead.
        assertTrue(
            shouldSynthesize(1, playing = 0, queued, offsets, lookaheadChars = 0, speed = 1f)
        )
        assertTrue(
            shouldSynthesize(3, playing = 0, queued, offsets, lookaheadChars = 200, speed = 1f)
        )
        assertFalse(
            shouldSynthesize(4, playing = 0, queued, offsets, lookaheadChars = 200, speed = 1f)
        )
    }

    @Test
    fun theLookaheadIsListeningTimeSoItGrowsWithSpeed() {
        val offsets = intArrayOf(0, 100, 200, 300, 400, 500)
        assertTrue(shouldSynthesize(4, playing = 0, 2, offsets, lookaheadChars = 200, speed = 1.5f))
        assertFalse(
            shouldSynthesize(4, playing = 0, 2, offsets, lookaheadChars = 200, speed = 1.4f)
        )
        assertFalse(
            shouldSynthesize(2, playing = 0, 1, offsets, lookaheadChars = 200, speed = 0.4f)
        )
    }

    @Test
    fun synthesisGoesOnWhenNothingIsQueuedPastWhatsPlaying() {
        val offsets = intArrayOf(0, 100, 200, 300, 400, 500)
        assertTrue(
            shouldSynthesize(
                4,
                playing = 2,
                lastQueued = 2,
                offsets,
                lookaheadChars = 0,
                speed = 1f,
            )
        )
        assertTrue(
            shouldSynthesize(
                4,
                playing = 0,
                lastQueued = null,
                offsets,
                lookaheadChars = 0,
                speed = 1f,
            )
        )
        assertFalse(
            shouldSynthesize(
                4,
                playing = 1,
                lastQueued = 2,
                offsets,
                lookaheadChars = 0,
                speed = 1f,
            )
        )
    }

    @Test
    fun itsFinishedOnceThePlayerEndsWithEverythingQueued() {
        assertTrue(finished(player(PlaybackState.ENDED), fed = true))
        // More is still coming.
        assertFalse(finished(player(PlaybackState.ENDED), fed = false))
        assertFalse(finished(player(PlaybackState.READY), fed = true))
    }
}
