package com.lionreader.app.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.shared.data.EntryDetail
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don't need.
@Config(application = android.app.Application::class)
class ShownArticleTest {
    @get:Rule val composeRule = createComposeRule()

    private fun entry(
        title: String = "Title",
        content: String? = "<p>Old</p>",
        summary: String? = null,
        read: Boolean = false,
        starred: Boolean = false,
    ) = EntryDetail("a", title, null, null, null, 0, read, starred, content, summary)

    private fun show(latest: EntryDetail): Pair<(EntryDetail) -> Unit, () -> EntryDetail?> {
        val state = mutableStateOf(latest)
        var shown: EntryDetail? = null
        composeRule.setContent { shown = rememberShownArticle("a", state.value) }
        return { next: EntryDetail ->
            state.value = next
        } to
            {
                composeRule.waitForIdle()
                shown
            }
    }

    @Test
    fun anEditWaitsForTheNextVisitButReadAndStarredDoNot() {
        val (update, shown) = show(entry())

        update(entry(title = "Edited", content = "<p>New</p>", read = true, starred = true))

        assertEquals(entry(read = true, starred = true), shown())
    }

    @Test
    fun aSummaryArrivingShowsAndOneGoingStays() {
        val (update, shown) = show(entry())

        update(entry(summary = "<p>Short</p>"))
        assertEquals(entry(summary = "<p>Short</p>"), shown())

        // The background download replaced the body, taking the summary with it.
        update(entry(content = "<p>New</p>", summary = null))
        assertEquals(entry(summary = "<p>Short</p>"), shown())
    }

    @Test
    fun untilItsBodyShowsTheArticleFollowsEdits() {
        val (update, shown) = show(entry(content = null))

        update(entry(title = "Edited", content = "<p>New</p>"))

        assertEquals(entry(title = "Edited", content = "<p>New</p>"), shown())
    }
}
