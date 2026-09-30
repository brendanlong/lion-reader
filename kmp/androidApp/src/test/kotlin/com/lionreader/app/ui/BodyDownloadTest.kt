package com.lionreader.app.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.lionreader.shared.data.EntryDetail
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don\'t need.
@Config(application = android.app.Application::class)
class BodyDownloadTest {
    @get:Rule val composeRule = createComposeRule()

    private fun entry(content: String?) =
        EntryDetail("a", "Title", null, null, null, 0, false, false, content, null)

    @Test
    fun anEntryThatLoadsAfterThePageStartsStillGetsItsBody() {
        // The entry's query hasn't answered yet when the page first composes.
        val entry = mutableStateOf<EntryDetail?>(null)
        var downloads = 0
        composeRule.setContent {
            rememberBodyDownload("a", entry.value) {
                downloads++
                true
            }
        }
        composeRule.waitForIdle()
        assertEquals(0, downloads)

        entry.value = entry(content = null)
        composeRule.waitForIdle()

        assertEquals(1, downloads)
    }

    @Test
    fun anEntryWithItsBodyIsLeftAlone() {
        var downloads = 0
        composeRule.setContent {
            rememberBodyDownload("a", entry("<p>Body</p>")) {
                downloads++
                true
            }
        }
        composeRule.waitForIdle()
        assertEquals(0, downloads)
    }

    @Test
    fun aFailedDownloadIsReported() {
        var failed = false
        composeRule.setContent {
            failed = rememberBodyDownload("a", entry(content = null)) { error("offline") }
        }
        composeRule.waitUntil { failed }
        assertTrue(failed)
    }
}
