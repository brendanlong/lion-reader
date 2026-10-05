package com.lionreader.app.ui

import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
// The real Application schedules WorkManager, which these tests don\'t need.
@Config(application = android.app.Application::class)
class ShownBodyTest {
    @get:Rule val composeRule = createComposeRule()

    @Test
    fun aBodyDeletedForDownloadingAgainStaysOnScreenUntilTheNewOneArrives() {
        val content = mutableStateOf<String?>("<p>Old</p>")
        var shown: String? = null
        composeRule.setContent { shown = rememberShownBody("a", content.value) }

        content.value = null
        composeRule.waitForIdle()
        assertEquals("<p>Old</p>", shown)

        content.value = "<p>New</p>"
        composeRule.waitForIdle()
        assertEquals("<p>New</p>", shown)
    }

    @Test
    fun anotherEntryDoesNotShowThePreviousOnesBody() {
        val id = mutableStateOf("a")
        val content = mutableStateOf<String?>("<p>A</p>")
        var shown: String? = null
        composeRule.setContent { shown = rememberShownBody(id.value, content.value) }

        id.value = "b"
        content.value = null
        composeRule.waitForIdle()

        assertNull(shown)
    }
}
