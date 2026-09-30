package com.lionreader.app.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.app.narration.NarratedArticle
import com.lionreader.app.narration.NarrationState
import com.lionreader.shared.data.EntryDetail
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don't need.
@Config(application = android.app.Application::class)
class NarrationFollowsPageTest {
    @get:Rule val composeRule = createComposeRule()

    private var narration by mutableStateOf<NarrationState?>(null)
    private var entryId by mutableStateOf("a")
    private var paragraphs by mutableStateOf<List<String>?>(null)
    private var started by mutableStateOf(true)
    private val narrated = mutableListOf<String>()
    private var stops = 0

    private fun playing(id: String, playing: Boolean = true) =
        NarrationState(id, "Title $id", paragraph = 0, playing = playing)

    private fun show() {
        composeRule.mainClock.autoAdvance = false
        composeRule.setContent {
            NarrationFollowsPage(
                narration,
                entryId,
                paragraphs,
                entry = entry(entryId),
                started = started,
                narrate = { article: NarratedArticle -> narrated += article.entryId },
                stop = { stops++ },
            )
        }
    }

    private fun entry(id: String) =
        EntryDetail(
            id = id,
            title = "Title $id",
            author = null,
            source = null,
            url = null,
            sortAtMillis = 0,
            read = false,
            starred = false,
            content = "<p>Body</p>",
            summary = null,
        )

    private fun after(millis: Long) {
        // Hand the test's state changes to the composition first.
        Snapshot.sendApplyNotifications()
        composeRule.mainClock.advanceTimeBy(millis)
        composeRule.waitForIdle()
    }

    @Test
    fun switchesToTheArticleSettledOnOnceItsLoaded() {
        narration = playing("a")
        show()
        entryId = "b"
        after(2_000)
        // Not loaded yet.
        assertEquals(emptyList<String>(), narrated)

        paragraphs = listOf("Hello.")
        after(500)
        // Not while it might be swiped past.
        assertEquals(emptyList<String>(), narrated)
        after(1_000)
        assertEquals(listOf("b"), narrated)
    }

    @Test
    fun swipingPastArticlesDoesNotStartThem() {
        narration = playing("a")
        paragraphs = listOf("Hello.")
        show()
        entryId = "b"
        after(300)
        entryId = "c"
        after(300)
        entryId = "d"
        after(1_500)

        assertEquals(listOf("d"), narrated)
    }

    @Test
    fun pausingOrStoppingWhileWaitingWins() {
        narration = playing("a")
        show()
        entryId = "b"
        after(500)
        narration = playing("a", playing = false)
        after(100)
        assertEquals(1, stops)

        narration = null
        paragraphs = listOf("Hello.")
        after(2_000)
        assertEquals(emptyList<String>(), narrated)
    }

    @Test
    fun aPausedNarrationEndsRatherThanFollow() {
        narration = playing("a", playing = false)
        paragraphs = listOf("Hello.")
        show()
        entryId = "b"
        after(2_000)

        assertEquals(1, stops)
        assertEquals(emptyList<String>(), narrated)
    }

    @Test
    fun waitsForTheAppToBeOnScreen() {
        narration = playing("a")
        paragraphs = listOf("Hello.")
        started = false
        show()
        entryId = "b"
        after(2_000)
        assertEquals(emptyList<String>(), narrated)

        started = true
        after(1_500)
        assertEquals(listOf("b"), narrated)
    }

    @Test
    fun theArticleBeingNarratedIsLeftAlone() {
        narration = playing("a")
        paragraphs = listOf("Hello.")
        show()
        after(2_000)

        assertTrue(narrated.isEmpty())
        assertEquals(0, stops)
    }
}
