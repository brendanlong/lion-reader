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
    private val followed = mutableListOf<String>()
    private val supplied = mutableListOf<String>()

    private fun on(id: String, playing: Boolean = true) =
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
                // As the narrator does: narration moves to the article, as it was.
                follow = { id, _ ->
                    narration?.let { current ->
                        if (current.entryId != id) {
                            followed += id
                            narration = current.copy(entryId = id)
                        }
                    }
                },
                supply = { article: NarratedArticle -> supplied += article.entryId },
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
    fun followsAtOnceAndSuppliesTheTextOnceSettled() {
        narration = on("a")
        show()
        entryId = "b"
        after(16)
        assertEquals(listOf("b"), followed)

        after(2_000)
        // Not loaded yet.
        assertEquals(emptyList<String>(), supplied)
        paragraphs = listOf("Hello.")
        after(500)
        // Not while it might be swiped past.
        assertEquals(emptyList<String>(), supplied)
        after(1_000)
        assertEquals(listOf("b"), supplied)
    }

    @Test
    fun swipingPastArticlesOnlySuppliesTheLast() {
        narration = on("a")
        paragraphs = listOf("Hello.")
        show()
        after(1_500)
        supplied.clear()
        entryId = "b"
        after(300)
        entryId = "c"
        after(300)
        entryId = "d"
        after(1_500)

        assertEquals(listOf("b", "c", "d"), followed)
        assertEquals(listOf("d"), supplied)
    }

    @Test
    fun aPausedNarrationFollowsToo() {
        narration = on("a", playing = false)
        paragraphs = listOf("Hello.")
        show()
        entryId = "b"
        after(2_000)

        assertEquals(listOf("b"), followed)
        assertEquals(false, narration?.playing)
        assertEquals(listOf("b"), supplied)
    }

    @Test
    fun nothingFollowsWhileNarrationIsOff() {
        paragraphs = listOf("Hello.")
        show()
        entryId = "b"
        after(2_000)

        assertTrue(followed.isEmpty())
        assertTrue(supplied.isEmpty())
    }

    @Test
    fun waitsForTheAppToBeOnScreen() {
        narration = on("a")
        paragraphs = listOf("Hello.")
        started = false
        show()
        entryId = "b"
        after(2_000)
        assertTrue(followed.isEmpty())

        started = true
        after(1_500)
        assertEquals(listOf("b"), followed)
        assertEquals(listOf("b"), supplied)
    }
}
